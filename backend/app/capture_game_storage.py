"""Phase 2 artifacts, reusing capture staging and its bounded batch contract."""
import json
import os
from bisect import bisect_right

import pyarrow as pa
import pyarrow.parquet as pq

from .capture_schemas import GameBatch
from .capture_storage import sha256_file

_COMMON_FIELDS = [
    ('capture_id', pa.string()), ('patient_id', pa.int64()), ('session_id', pa.int64()),
    ('trial_id', pa.int64()), ('game_key', pa.string()), ('sequence', pa.int64()),
    ('timestamp_ms', pa.float64()), ('source_timestamp_ms', pa.float64()),
    ('source_observation_id', pa.int64()), ('frame_id', pa.int64()), ('payload_json', pa.string()),
]
EVENT_SCHEMA = pa.schema(_COMMON_FIELDS + [
    ('event_id', pa.string()), ('event_schema_version', pa.int64()), ('event_type', pa.string()),
])
SAMPLE_SCHEMA = pa.schema(_COMMON_FIELDS + [
    ('sample_id', pa.string()), ('sample_schema_version', pa.int64()), ('sample_type', pa.string()),
])
MAX_GAME_RECORDS = 2_000_000
MAX_OBSERVATION_RANGES = 100_000
MAX_GAME_ENTITIES = 100_000


class _GameHistory:
    """Bounded identity checks for reconstruction; never interprets scores clinically."""
    def __init__(self):
        self.started = False
        self.terminal = False
        self.entities = {'target_id': {}, 'stroke_id': {}, 'drag_id': {}}

    def _identity(self, payload, key):
        value = payload.get(key)
        if type(value) not in (str, int) or str(value) == '':
            raise ValueError(f'Game record requires {key}')
        return value

    def _known(self, payload, key):
        identity = self._identity(payload, key)
        if identity not in self.entities[key]:
            raise ValueError(f'Game record references an unknown {key}')
        return identity

    def event(self, record):
        kind, payload = record.event_type, record.payload
        if kind == 'GAME_STARTED':
            if self.started:
                raise ValueError('Game history has multiple start events')
            self.started = True
            return
        if not self.started or self.terminal:
            raise ValueError('Game events must follow start and precede terminal event')
        if kind in ('GAME_COMPLETED', 'GAME_CANCELLED', 'GAME_STOPPED'):
            self.terminal = True
        starts = {'TARGET_SPAWNED': 'target_id', 'STROKE_STARTED': 'stroke_id', 'STROKE_GRABBED': 'drag_id'}
        ends = {'TARGET_TOUCHED': 'target_id', 'STROKE_COMPLETED': 'stroke_id',
            'STROKE_RELEASED': 'drag_id', 'DRAG_INTERRUPTED': 'drag_id'}
        if kind in starts:
            key = starts[kind]
            identity = self._identity(payload, key)
            if identity in self.entities[key]:
                raise ValueError(f'Game history repeats {key}')
            if kind == 'STROKE_GRABBED':
                self._known(payload, 'stroke_id')
            if sum(len(values) for values in self.entities.values()) >= MAX_GAME_ENTITIES:
                raise ValueError('Game entity verification limit exceeded')
            self.entities[key][identity] = False
        elif kind in ends:
            key = ends[kind]
            identity = self._known(payload, key)
            if self.entities[key][identity]:
                raise ValueError(f'Game history completes {key} twice')
            self.entities[key][identity] = True

    def sample(self, record):
        if record.sample_type == 'flower_cursor':
            self._known(record.payload, 'target_id')
        elif record.sample_type in ('drawing_stroke_point', 'drawing_drag_point'):
            self._known(record.payload, 'stroke_id')
            if record.sample_type == 'drawing_drag_point':
                self._known(record.payload, 'drag_id')


def iter_game_rows(path):
    """Read back verified Parquet in bounded batches; preserve original payload."""
    with pq.ParquetFile(path) as parquet:
        for batch in parquet.iter_batches(batch_size=512):
            for row in batch.to_pylist():
                yield {**row, 'payload': json.loads(row['payload_json'])}


def _observation_ranges(folder):
    """Index ordered source identities once, compressing adjacent IDs into ranges."""
    frames = folder / 'frames.parquet'
    if not frames.is_file():
        return []
    ranges = []
    with pq.ParquetFile(frames) as parquet:
        for batch in parquet.iter_batches(batch_size=512, columns=['source_observation_id']):
            for identity in batch.column(0).to_pylist():
                if identity is None:
                    continue
                if ranges and identity <= ranges[-1][1]:
                    raise ValueError('Frame source observation identities must be strictly ordered')
                if ranges and identity == ranges[-1][1] + 1:
                    ranges[-1] = (ranges[-1][0], identity)
                else:
                    ranges.append((identity, identity))
                    if len(ranges) > MAX_OBSERVATION_RANGES:
                        raise ValueError('Source observation range verification limit exceeded')
    return ranges


def _check_frame_links(folder, records, observation_ranges):
    wanted_frames = {}
    for record in records:
        if record.frame_id is not None:
            wanted_frames.setdefault(record.frame_id, []).append(record)
        if record.source_observation_id is not None:
            identity = record.source_observation_id
            index = bisect_right(observation_ranges, (identity, float('inf'))) - 1
            if index < 0 or observation_ranges[index][1] < identity:
                raise ValueError('Game mapping references an unavailable source observation')
    if not wanted_frames:
        return
    frames = folder / 'frames.parquet'
    if not frames.is_file():
        raise ValueError('Game observation mapping has no frames artifact')
    with pq.ParquetFile(frames) as parquet:
        for batch in parquet.iter_batches(batch_size=512,
                columns=['frame_id', 'source_observation_id', 'timestamp_ms']):
            for frame in batch.to_pylist():
                for record in wanted_frames.pop(frame['frame_id'], []):
                    if (record.source_observation_id is not None
                            and record.source_observation_id != frame['source_observation_id']
                            or record.source_timestamp_ms is not None
                            and abs(record.source_timestamp_ms - frame['timestamp_ms']) > 0.000001):
                        raise ValueError('Exact game frame mapping differs from source observation')
            if not wanted_frames:
                return
    raise ValueError('Game mapping references an unavailable frame or source observation')


def convert_game_data(folder, paths, capture_id, patient_id, session_id, trial_id, game_key, duration_ms, *, require_complete=False):
    """Validate checksums, identities and both timelines before publishing artifacts."""
    base = dict(patient_id=patient_id, session_id=session_id)
    observation_ranges = _observation_ranges(folder)
    history = _GameHistory()
    states = {'events': [-1, -1.0, 0], 'interaction_samples': [-1, -1.0, 0]}
    temporary = [folder / 'events.parquet.tmp', folder / 'interaction_samples.parquet.tmp']
    with pq.ParquetWriter(temporary[0], EVENT_SCHEMA) as event_writer, pq.ParquetWriter(temporary[1], SAMPLE_SCHEMA) as sample_writer:
        for batch_index, path in enumerate(paths):
            digest = path.with_suffix('.sha256')
            if not digest.is_file() or sha256_file(path) != digest.read_text(encoding='ascii'):
                raise ValueError('Game batch integrity check failed')
            batch = GameBatch.model_validate_json(path.read_bytes())
            if batch.batch_index != batch_index:
                raise ValueError('Game batch index differs from its staged position')
            _check_frame_links(folder, [*batch.events, *batch.samples], observation_ranges)
            for name, records, writer, schema, id_name in (
                ('events', batch.events, event_writer, EVENT_SCHEMA, 'event'),
                ('interaction_samples', batch.samples, sample_writer, SAMPLE_SCHEMA, 'sample'),
            ):
                rows = []
                state = states[name]
                for record in records:
                    if record.capture_id != str(capture_id) or record.trial_id != trial_id or record.game_key != game_key:
                        raise ValueError('Game record identity does not match capture, trial and game')
                    if record.sequence != state[0] + 1:
                        raise ValueError('Game record sequence must be contiguous across batches')
                    if record.timestamp_ms < state[1] or record.timestamp_ms > duration_ms:
                        raise ValueError('Game timeline must be monotonic within capture duration')
                    if record.source_timestamp_ms is not None and record.source_timestamp_ms > duration_ms:
                        raise ValueError('Game source timeline exceeds capture duration')
                    # Stable IDs encode their stream and sequence, so uniqueness needs no unbounded ID set.
                    if getattr(record, f'{id_name}_id') != f'{capture_id}:{id_name}:{record.sequence}':
                        raise ValueError('Game record ID must contain capture, stream and sequence')
                    if name == 'events':
                        history.event(record)
                    else:
                        history.sample(record)
                    state[:] = [record.sequence, record.timestamp_ms, state[2] + 1]
                    if sum(item[2] for item in states.values()) > MAX_GAME_RECORDS:
                        raise ValueError('Game artifact record limit exceeded')
                    values = record.model_dump(mode='json')
                    payload = values.pop('payload')
                    rows.append({**base, **values, 'payload_json': json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False)})
                if rows:
                    writer.write_table(pa.Table.from_pylist(rows, schema=schema))
    if require_complete and (not history.started or not history.terminal):
        raise ValueError('Complete game capture requires start and terminal events')
    summary = {}
    for name, schema, path in zip(states, (EVENT_SCHEMA, SAMPLE_SCHEMA), temporary):
        with pq.ParquetFile(path) as parquet:
            if parquet.schema_arrow != schema or parquet.metadata.num_rows != states[name][2]:
                raise ValueError('Game Parquet schema or row-count verification failed')
        final = folder / f'{name}.parquet'
        os.replace(path, final)
        summary.update({f'{name}_sha256': sha256_file(final), f'{name}_size_bytes': final.stat().st_size,
            f'{name}_status': 'complete', f'{name}_file': final.name})
    return {**summary, 'event_count': states['events'][2], 'interaction_sample_count': states['interaction_samples'][2]}


def write_game_metrics(folder, capture, summary):
    from .game_metrics import compute_game_metrics
    game_key = (capture.model_config_info or {}).get('exercise_code')
    metrics = compute_game_metrics(iter_game_rows(folder / 'events.parquet'),
        iter_game_rows(folder / 'interaction_samples.parquet'), game_key=game_key,
        capture_id=capture.id, trial_id=capture.trial_id)
    metrics = {**metrics, 'source_artifact_checksums': {
        'events.parquet': summary['events_sha256'],
        'interaction_samples.parquet': summary['interaction_samples_sha256']}}
    temporary = folder / 'game_metrics.json.tmp'
    with temporary.open('w', encoding='utf-8') as target:
        json.dump(metrics, target, ensure_ascii=False, indent=2, allow_nan=False)
        target.flush()
        os.fsync(target.fileno())
    # Verify that generated JSON is readable before making it available to reports.
    with temporary.open(encoding='utf-8') as source:
        json.load(source)
    final = folder / 'game_metrics.json'
    os.replace(temporary, final)
    return dict(game_metrics_status='complete', game_metrics_file=final.name,
        game_metrics_sha256=sha256_file(final), game_metrics_size_bytes=final.stat().st_size,
        game_metrics=metrics['trial'])
