"""Phase 2 contracts and real Parquet artifact checks; no clinical data."""
import hashlib
import json
from uuid import uuid4

import pyarrow.parquet as pq
import pytest
from pydantic import ValidationError

from app.capture_schemas import GameBatch
from app.capture_game_storage import convert_game_data, EVENT_SCHEMA, SAMPLE_SCHEMA


def row(capture_id, sequence, kind='event', timestamp=10):
    common = dict(capture_id=capture_id, trial_id=3, game_key='glowing_flower',
        sequence=sequence, timestamp_ms=timestamp, source_timestamp_ms=None,
        source_observation_id=None, frame_id=None, payload={})
    if kind == 'event':
        return dict(**common, event_id=f'{capture_id}:event:{sequence}',
            event_schema_version=1, event_type='GAME_STARTED')
    return dict(**{**common, 'payload': {'target_id': 'target-1', 'x': 20., 'y': 30., 'coordinate_space': 'display_pixels', 'width': 640, 'height': 480}}, sample_id=f'{capture_id}:sample:{sequence}',
        sample_schema_version=1, sample_type='flower_cursor',
        )


def staged(tmp_path, capture_id, events, samples):
    batch = GameBatch(batch_index=0, events=events, samples=samples)
    path = tmp_path / '0.json'
    path.write_bytes(batch.model_dump_json().encode())
    path.with_suffix('.sha256').write_text(hashlib.sha256(path.read_bytes()).hexdigest())
    return path


def test_game_parquet_readback_and_checksum(tmp_path):
    identity = str(uuid4())
    event = row(identity, 0)
    sample = row(identity, 0, 'sample')
    spawn = {**row(identity, 1), 'event_type': 'TARGET_SPAWNED', 'payload': {'target_id': 'target-1'}}
    path = staged(tmp_path, identity, [event, spawn], [sample])
    summary = convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)
    for name, schema, count in [('events', EVENT_SCHEMA, 2), ('interaction_samples', SAMPLE_SCHEMA, 1)]:
        artifact = tmp_path / f'{name}.parquet'
        table = pq.read_table(artifact)
        assert table.schema == schema and table.num_rows == count
        assert hashlib.sha256(artifact.read_bytes()).hexdigest() == summary[f'{name}_sha256']
        recorded = table.to_pylist()[0]
        assert recorded['capture_id'] == identity and recorded['trial_id'] == 3
        assert recorded['frame_id'] is None
        if name == 'interaction_samples':
            assert json.loads(recorded['payload_json'])['x'] == 20


@pytest.mark.parametrize('change,reason', [
    ({'trial_id': 4}, 'identity'), ({'capture_id': str(uuid4())}, 'identity'),
    ({'game_key': 'free_drawing'}, 'identity'), ({'sequence': 2}, 'sequence'),
    ({'timestamp_ms': 200}, 'timeline'),
])
def test_game_conversion_rejects_mixed_trial_and_invalid_timeline(tmp_path, change, reason):
    identity = str(uuid4())
    path = staged(tmp_path, identity, [{**row(identity, 0), **change}], [])
    with pytest.raises(ValueError, match=reason):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)


def test_game_conversion_detects_tampering_and_cross_batch_duplicate(tmp_path):
    identity = str(uuid4())
    path = staged(tmp_path, identity, [row(identity, 0)], [])
    second = tmp_path / '1.json'
    second.write_text(GameBatch(batch_index=1, events=[row(identity, 0)], samples=[]).model_dump_json())
    second.with_suffix('.sha256').write_text(hashlib.sha256(second.read_bytes()).hexdigest())
    with pytest.raises(ValueError, match='sequence'):
        convert_game_data(tmp_path, [path, second], identity, 1, 2, 3, 'glowing_flower', 100)
    path.write_text('{}')
    with pytest.raises(ValueError, match='integrity'):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)


def test_game_schema_rejects_nonfinite_nested_payload_and_empty_batches():
    identity = str(uuid4())
    with pytest.raises(ValidationError):
        GameBatch(batch_index=0, events=[{**row(identity, 0), 'payload': {'x': float('nan')}}], samples=[])
    with pytest.raises(ValidationError):
        GameBatch(batch_index=0, events=[], samples=[])


def test_game_conversion_checks_source_observations_without_invented_frame_mapping(tmp_path):
    import pyarrow as pa
    identity = str(uuid4())
    pq.write_table(pa.table({'frame_id': [0], 'source_observation_id': [9], 'timestamp_ms': [10.]}), tmp_path / 'frames.parquet')
    event = {**row(identity, 0), 'source_observation_id': 99}
    path = staged(tmp_path, identity, [event], [])
    with pytest.raises(ValueError, match='observation'):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)


def test_game_conversion_checks_every_record_sharing_exact_frame(tmp_path):
    import pyarrow as pa
    identity = str(uuid4())
    pq.write_table(pa.table({'frame_id': [0], 'source_observation_id': [9], 'timestamp_ms': [10.]}), tmp_path / 'frames.parquet')
    events = [{**row(identity, 0), 'frame_id': 0, 'source_observation_id': 8},
              {**row(identity, 1), 'frame_id': 0, 'source_observation_id': 9}]
    path = staged(tmp_path, identity, events, [])
    with pytest.raises(ValueError, match='observation'):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)


def test_game_conversion_verifies_batch_index_inside_staged_file(tmp_path):
    identity = str(uuid4())
    path = staged(tmp_path, identity, [row(identity, 0)], [])
    data = json.loads(path.read_text())
    data['batch_index'] = 4
    path.write_text(json.dumps(data))
    path.with_suffix('.sha256').write_text(hashlib.sha256(path.read_bytes()).hexdigest())
    with pytest.raises(ValueError, match='batch index'):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)


def test_complete_game_data_requires_one_start_and_terminal_event(tmp_path):
    identity = str(uuid4())
    path = staged(tmp_path, identity, [row(identity, 0)], [])
    with pytest.raises(ValueError, match='terminal'):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100, require_complete=True)


def test_samples_must_reference_entities_that_actually_started(tmp_path):
    identity = str(uuid4())
    path = staged(tmp_path, identity, [row(identity, 0)], [row(identity, 0, 'sample')])
    with pytest.raises(ValueError, match='target'):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)


def test_missing_processed_coordinates_are_rejected_but_unusable_cursor_is_preserved():
    identity = str(uuid4())
    sample = row(identity, 0, 'sample')
    with pytest.raises(ValidationError):
        GameBatch(batch_index=0, samples=[{**sample, 'payload': {**sample['payload'], 'x': None}}])
    with pytest.raises(ValidationError):
        GameBatch(batch_index=0, samples=[{**sample, 'payload': {**sample['payload'], 'x': 10 ** 1000}}])
    batch = GameBatch(batch_index=0, samples=[{**sample, 'payload': {**sample['payload'], 'x': None, 'y': None, 'usable': False}}])
    assert batch.samples[0].payload['usable'] is False


def test_observation_range_index_preserves_gaps_and_bounds_memory(tmp_path, monkeypatch):
    import pyarrow as pa
    from app import capture_game_storage
    identity = str(uuid4())
    pq.write_table(pa.table({'source_observation_id': [1, 3]}), tmp_path / 'frames.parquet')
    path = staged(tmp_path, identity, [{**row(identity, 0), 'source_observation_id': 2}], [])
    with pytest.raises(ValueError, match='observation'):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)
    monkeypatch.setattr(capture_game_storage, 'MAX_OBSERVATION_RANGES', 1)
    with pytest.raises(ValueError, match='limit'):
        convert_game_data(tmp_path, [path], identity, 1, 2, 3, 'glowing_flower', 100)
