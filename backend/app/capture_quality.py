"""Read-only, reproducible quality assessment of existing capture artifacts."""
import json
import math
import re
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict, Any

import pyarrow.parquet as pq

from .benchmark_storage import executable
from .capture_game_storage import EVENT_SCHEMA, SAMPLE_SCHEMA
from .capture_storage import FRAME_SCHEMA, LANDMARK_SCHEMA, sha256_file

SCHEMAS = {'frames': FRAME_SCHEMA, 'landmarks': LANDMARK_SCHEMA,
           'events': EVENT_SCHEMA, 'interaction_samples': SAMPLE_SCHEMA}
NAMES = {'frames': 'frames.parquet', 'landmarks': 'landmarks.parquet',
         'events': 'events.parquet', 'interaction_samples': 'interaction_samples.parquet',
         'game_metrics': 'game_metrics.json', 'manifest': 'manifest.json'}


class QualityReport(TypedDict):
    quality_policy_version: str
    generated_at: str
    capture_id: str
    session_id: int
    trial_id: int
    source_type: str
    input_fingerprints: dict
    artifact_integrity: dict
    pose_quality: dict
    hand_quality: dict
    landmark_spatial_quality: dict
    temporal_quality: dict
    interaction_quality: dict
    metrics_quality: dict
    research_usability: dict
    warnings: list
    exclusion_reasons: list
    limitations: list
    delegates: Any


def _ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def _percentile(values, p):
    values = sorted(v for v in values if isinstance(v, (int, float)) and math.isfinite(v))
    if not values:
        return None
    rank = (len(values) - 1) * p
    lo, hi = math.floor(rank), math.ceil(rank)
    return values[lo] + (values[hi] - values[lo]) * (rank - lo)


def _decode(path):
    try:
        result = subprocess.run([executable('ffmpeg'), '-nostdin', '-v', 'warning', '-i', str(path),
                                 '-map', '0:v:0', '-f', 'null', '-'],
                                capture_output=True, text=True, timeout=60, check=False)
        warnings = [re.sub(r' @ (?:0x)?[0-9a-fA-F]+(?=\])', ' @ decoder', line)
                    for line in result.stderr[-8000:].splitlines()]
        return {'status': 'complete' if result.returncode == 0 else 'failed', 'warnings': warnings}
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return {'status': 'not_assessed', 'reason': type(exc).__name__, 'warnings': []}


def _artifact(root, kind, requested, summary, manifest_artifacts):
    entry = manifest_artifacts.get(kind, {})
    expected_status = summary.get(kind + '_status', entry.get('status', 'not_assessed'))
    name = summary.get(kind + '_file') or entry.get('name') or NAMES.get(kind)
    if kind in ('video', 'tracking_video') and not name:
        name = None
    safe = isinstance(name, str) and Path(name).name == name and name not in ('.', '..')
    path = root / name if safe else None
    exists = bool(path and path.is_file() and path.resolve().parent == root.resolve())
    result = {'expected_status': expected_status, 'exists': exists, 'name': name if safe else None,
              'expected_size_bytes': summary.get(kind + '_size_bytes', entry.get('size_bytes')),
              'actual_size_bytes': path.stat().st_size if exists else None,
              'expected_sha256': summary.get(kind + '_sha256', entry.get('sha256')),
              'actual_sha256': None, 'sha256_match': None, 'size_match': None,
              'schema_valid': None, 'row_count': None, 'expected_row_count': entry.get('record_count'),
              'row_count_match': None, 'decode': {'status': 'not_assessed'}}
    if not requested and not exists:
        result['status'] = 'not_requested'
        return result
    if not exists:
        result['status'] = 'missing' if requested else 'not_requested'
        return result
    try:
        result['actual_sha256'] = sha256_file(path)
        if result['expected_sha256'] is not None:
            result['sha256_match'] = result['actual_sha256'] == result['expected_sha256']
        if result['expected_size_bytes'] is not None:
            result['size_match'] = result['actual_size_bytes'] == result['expected_size_bytes']
        if kind in SCHEMAS:
            parquet = pq.ParquetFile(path)
            actual_schema = parquet.schema_arrow
            expected_schema = SCHEMAS[kind]
            required = {'capture_id', 'session_id', 'trial_id', 'timestamp_ms'}
            required |= {'frame_id'} if kind in ('frames', 'landmarks') else {'sequence'}
            fields = {field.name: field.type for field in expected_schema}
            result['schema_valid'] = required.issubset(actual_schema.names) and all(
                field.name in fields and fields[field.name] == field.type for field in actual_schema)
            result['schema_compatibility'] = 'current' if actual_schema == expected_schema else 'legacy_subset' if result['schema_valid'] else 'invalid'
            result['row_count'] = parquet.metadata.num_rows
            if result['expected_row_count'] is not None:
                result['row_count_match'] = result['row_count'] == result['expected_row_count']
        elif kind in ('video', 'tracking_video'):
            result['decode'] = _decode(path)
        elif kind in ('manifest', 'game_metrics'):
            with path.open(encoding='utf-8') as stream:
                value = json.load(stream)
            result['schema_valid'] = isinstance(value, dict) and all(k in value for k in ('capture_id', 'session_id', 'trial_id') if kind == 'manifest')
            if kind == 'game_metrics':
                result['schema_valid'] = isinstance(value, dict) and all(k in value for k in ('capture_id', 'trial_id', 'trial'))
        failed = (result['sha256_match'] is False or result['size_match'] is False or
                  result['schema_valid'] is False or result['row_count_match'] is False or result['decode']['status'] == 'failed')
        result['status'] = 'failed' if failed else ('incomplete' if expected_status == 'incomplete' else
            'complete' if expected_status == 'complete' and result['sha256_match'] is True else 'not_assessed')
    except Exception as exc:
        result['status'] = 'failed'
        result['error'] = type(exc).__name__
    return result


def _rows(root, kind, integrity):
    entry = integrity[kind]
    if not entry['exists'] or entry['schema_valid'] is not True or entry['status'] == 'failed':
        return []
    try:
        return pq.read_table(root / entry['name']).to_pylist()
    except (OSError, ValueError):
        return []


def _model_quality(frames, model, duration):
    counts = Counter(row.get(model + '_inference_status') or 'unknown' for row in frames)
    attempted = sum(counts[k] for k in ('detected', 'not_detected', 'error', 'missing_result'))
    latency = [row[model + '_inference_ms'] for row in frames if row.get(model + '_inference_ms') is not None]
    valid = counts['detected'] + counts['not_detected']
    return {'counts': {k: counts[k] for k in ('detected', 'not_detected', 'not_run', 'error', 'missing_result', 'unknown')},
            'attempted_inference_count': attempted, 'detection_rate': _ratio(counts['detected'], valid),
            'detection_rate_reason': None if valid else 'no_detected_or_not_detected_results',
            'result_coverage': _ratio(valid, attempted) if not counts['unknown'] else None,
            'error_rate': _ratio(counts['error'], attempted) if not counts['unknown'] else None,
            'missing_result_rate': _ratio(counts['missing_result'], attempted) if not counts['unknown'] else None,
            'attempted_denominator_reason': 'unknown_statuses_prevent_attempt_count' if counts['unknown'] else None if attempted else 'no_known_attempts',
            'inference_rate_hz': attempted * 1000 / duration if not counts['unknown'] and duration and duration > 0 else None,
            'inference_rate_window': 'first_to_last_capture_observation_timestamp',
            'latency_p50_ms': _percentile(latency, .5), 'latency_p95_ms': _percentile(latency, .95),
            'latency_sample_count': len(latency), 'percentile_method': 'linear interpolation, rank=(n-1)*p',
            'skipped_frame_count': sum(row.get('skipped_frames') or 0 for row in frames)}


def _temporal(frames, capture):
    def differences(key):
        values = [r[key] for r in frames if r.get(key) is not None]
        return [b-a for a, b in zip(values, values[1:])]
    dt, frame_ids, obs_ids, source_ids, media = (differences(k) for k in
        ('timestamp_ms', 'frame_id', 'source_observation_id', 'source_frame_id', 'video_media_time_ms'))
    return {'observation_count': len(frames), 'timestamp_reversals': sum(d < 0 for d in dt),
            'duplicate_timestamps': sum(d == 0 for d in dt),
            'frame_id_missing': sum(max(0, d-1) for d in frame_ids),
            'frame_id_nonincreasing': sum(d <= 0 for d in frame_ids),
            'observation_id_missing': sum(max(0, d-1) for d in obs_ids),
            'observation_id_nonincreasing': sum(d <= 0 for d in obs_ids),
            'source_frame_gaps': sum(max(0, d-1) for d in source_ids),
            'timestamp_gap_ms': {'count': len(dt), 'p50': _percentile(dt, .5), 'p95': _percentile(dt, .95),
                                 'max': max(dt) if dt else None},
            'source_media_time': {'samples': len(media)+1 if media else 0, 'reversals': sum(d < 0 for d in media)},
            'skipped_frames': sum(r.get('skipped_frames') or 0 for r in frames),
            'missing_inference_callbacks': {m: sum(r.get(m+'_inference_status') == 'missing_result' for r in frames) for m in ('pose', 'hand')},
            'recorder_start': (getattr(capture, 'model_config_info', None) or {}).get('recorder_start'),
            'video_alignment': {'status': 'not_assessed', 'reason': 'encoded video PTS mapping unavailable; error unmeasured'}}


def _spatial(rows):
    output = {}
    for model in ('pose', 'hand'):
        selected = [r for r in rows if r.get('landmark_source') == model and r.get('coordinate_space') == 'normalized_image' and r.get('representation') == 'raw']
        outside = [r for r in selected if all(isinstance(r.get(k), (int, float)) and math.isfinite(r[k]) for k in ('x','y')) and not (0 <= r['x'] <= 1 and 0 <= r['y'] <= 1)]
        grouped = {}
        for r in selected:
            key = str(r.get('landmark_index')) + ':' + str(r.get('landmark_name'))
            group = grouped.setdefault(key, {'count': 0, 'out_of_image': 0})
            group['count'] += 1
            if isinstance(r.get('x'), (int,float)) and isinstance(r.get('y'), (int,float)) and (r['x'] < 0 or r['x'] > 1 or r['y'] < 0 or r['y'] > 1):
                group['out_of_image'] += 1
        output[model] = {'count': len(selected), 'valid_coordinate_count': sum(bool(r.get('is_valid')) for r in selected),
                         'nonfinite_or_missing_coordinate_count': sum(not all(isinstance(r.get(k), (int, float)) and math.isfinite(r[k]) for k in ('x', 'y', 'z')) for r in selected),
                         'out_of_image_count': len(outside), 'out_of_image_ratio': _ratio(len(outside), len(selected)),
                         'invalid_reason_distribution': dict(Counter(r.get('invalid_reason') for r in selected if r.get('invalid_reason'))),
                         'by_landmark': grouped}
    output['limitations'] = ['Raw normalized-image points only; world coordinates excluded.', 'Out-of-image is not a clinical accuracy assessment.']
    return output


def _stream_checks(rows, capture, sequence=False):
    identity_errors = sum(any(str(r.get(key)) != str(value) for key, value in (
        ('capture_id', capture.id), ('session_id', capture.session_id), ('trial_id', capture.trial_id))) for r in rows)
    times = [r.get('timestamp_ms') for r in rows]
    reversals = sum(b < a for a, b in zip(times, times[1:]) if a is not None and b is not None)
    duplicates = sum(b == a for a, b in zip(times, times[1:]) if a is not None and b is not None)
    gaps = sum(r.get('sequence') != i for i, r in enumerate(rows)) if sequence else None
    return {'rows': len(rows), 'identity_mismatches': identity_errors, 'timestamp_reversals': reversals,
            'duplicate_timestamps': duplicates, 'sequence_mismatches': gaps}


def _payload(row):
    try:
        value = json.loads(row.get('payload_json') or '{}')
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def _interaction(events, samples, frames, game):
    kinds = Counter(r.get('event_type') for r in events)
    types = Counter(r.get('sample_type') for r in samples)
    start = next((r for r in events if r.get('event_type') == 'GAME_STARTED'), None)
    end = next((r for r in events if r.get('event_type') in ('GAME_COMPLETED','GAME_STOPPED','GAME_CANCELLED','GAME_ABORTED')), None)
    state = _payload(start).get('tracking_usable') if start else None
    prior = start.get('timestamp_ms') if start else None
    usable = unusable = unknown = 0.0
    for r in events:
        t = r.get('timestamp_ms')
        if prior is None or t is None or t < prior:
            continue
        delta = t - prior
        if state is True:
            usable += delta
        elif state is False:
            unusable += delta
        else:
            unknown += delta
        prior = t
        if r.get('event_type') == 'TRACKING_LOST':
            state = False
        elif r.get('event_type') == 'TRACKING_RECOVERED':
            state = True
        if r is end:
            break
    window = [r for r in events if start and end and isinstance(r.get('timestamp_ms'), (int, float))
              and isinstance(start.get('timestamp_ms'), (int, float)) and isinstance(end.get('timestamp_ms'), (int, float))
              and start['timestamp_ms'] <= r['timestamp_ms'] <= end['timestamp_ms']]
    window_kinds = Counter(r.get('event_type') for r in window)
    valid_window = bool(start and end and isinstance(start.get('timestamp_ms'), (int, float))
                        and isinstance(end.get('timestamp_ms'), (int, float))
                        and math.isfinite(start['timestamp_ms']) and math.isfinite(end['timestamp_ms'])
                        and end['timestamp_ms'] >= start['timestamp_ms'])
    tracking = {'loss_count': window_kinds['TRACKING_LOST'], 'recovery_count': window_kinds['TRACKING_RECOVERED'],
                'usable_duration_ms': usable if valid_window else None,
                'unusable_duration_ms': unusable if valid_window else None,
                'unknown_duration_ms': unknown if valid_window else None,
                'duration_reason': None if valid_window else 'missing_or_invalid_game_interval',
                'method': 'integrate game tracking_usable transitions from GAME_STARTED through terminal event; includes initial state'}
    observed = {r.get('source_observation_id') for r in frames if r.get('source_observation_id') is not None}
    linked = [r for r in samples if r.get('source_observation_id') is not None]
    payloads = [_payload(r) for r in samples]
    fresh = sum(p.get('usable') is True and p.get('freshness') == 'fresh' for p in payloads)
    gaps = [b['timestamp_ms'] - a['timestamp_ms'] for a, b in zip(samples, samples[1:])
            if a.get('timestamp_ms') is not None and b.get('timestamp_ms') is not None and
            (game != 'free_drawing' or (_payload(a).get('stroke_id') is not None and _payload(a).get('stroke_id') == _payload(b).get('stroke_id')))]
    spawn_ids = [_payload(r).get('target_id') for r in events if r.get('event_type') == 'TARGET_SPAWNED']
    touch_ids = [_payload(r).get('target_id') for r in events if r.get('event_type') == 'TARGET_TOUCHED']
    targets_seen, touched, target_consistent = set(), set(), True
    for event in events:
        kind, target = event.get('event_type'), _payload(event).get('target_id')
        if kind == 'TARGET_SPAWNED':
            target_consistent = target_consistent and target is not None and target not in targets_seen
            targets_seen.add(target)
        elif kind == 'TARGET_TOUCHED':
            target_consistent = target_consistent and target in targets_seen and target not in touched
            touched.add(target)
    strokes = [_payload(r) for r in events if r.get('event_type') == 'STROKE_COMPLETED']
    pen_down, pen_errors, history_errors = False, 0, 0
    open_strokes, finished_strokes, canvas = set(), set(), set()
    history_reference_errors = 0
    for event in events:
        kind, payload = event.get('event_type'), _payload(event)
        stroke = payload.get('stroke_id')
        if kind == 'PEN_DOWN':
            pen_errors += int(pen_down)
            pen_down = True
        elif kind == 'PEN_UP':
            pen_errors += int(not pen_down)
            pen_down = False
        elif kind == 'STROKE_STARTED':
            history_errors += int(stroke is None or stroke in open_strokes or stroke in finished_strokes)
            open_strokes.add(stroke)
        elif kind == 'STROKE_COMPLETED':
            history_errors += int(stroke not in open_strokes)
            open_strokes.discard(stroke)
            finished_strokes.add(stroke)
            canvas.add(stroke)
        elif kind == 'UNDO' and payload.get('operation') in ('add', 'move'):
            history_reference_errors += int(stroke not in canvas)
            if payload.get('operation') == 'add':
                canvas.discard(stroke)
        elif kind == 'CLEAR_CANVAS':
            ids = payload.get('stroke_ids')
            if not isinstance(ids, list) or set(ids) != canvas:
                history_reference_errors += 1
            canvas.clear()
    return {'game_key': game, 'event_count': len(events), 'event_counts': dict(kinds), 'sample_count': len(samples),
            'sample_counts': dict(types), 'tracking_interruptions': tracking,
            'source_observation_linkage': {'with_id': len(linked), 'matched': sum(r['source_observation_id'] in observed for r in linked),
                                           'unmatched': sum(r['source_observation_id'] not in observed for r in linked), 'missing_id': len(samples)-len(linked)},
            'usable_fresh_count': fresh, 'usable_fresh_ratio': _ratio(fresh, len(samples)),
            'trajectory_gap_ms': {'count': len(gaps), 'p50': _percentile(gaps,.5), 'p95': _percentile(gaps,.95), 'max': max(gaps) if gaps else None},
            'target_spawn_count': len(spawn_ids), 'target_touch_count': len(touch_ids),
            'target_consistent': target_consistent,
            'stroke_count': kinds['STROKE_STARTED'], 'accepted_stroke_point_count': types['drawing_stroke_point'],
            'completed_stroke_count': len(strokes), 'interrupted_stroke_count': sum(p.get('interrupted') is True for p in strokes),
            'pen_down_count': kinds['PEN_DOWN'], 'pen_up_count': kinds['PEN_UP'],
            'pen_balanced': kinds['PEN_DOWN'] == kinds['PEN_UP'], 'pen_transition_errors': pen_errors,
            'stroke_history_errors': history_errors, 'open_stroke_count': len(open_strokes),
            'undo_clear_history_status': 'reference_mismatch' if history_reference_errors else 'references_consistent' if kinds['UNDO'] or kinds['CLEAR_CANVAS'] else 'no_undo_or_clear_events',
            'undo_clear_reference_errors': history_reference_errors,
            'drag_attempt_count': kinds['STROKE_GRABBED'], 'drag_completed_count': kinds['STROKE_RELEASED'],
            'drag_interrupted_count': kinds['DRAG_INTERRUPTED'], 'undo_count': kinds['UNDO'], 'clear_count': kinds['CLEAR_CANVAS'],
            'continuous_hand_trajectory': 'not_recorded' if game == 'free_drawing' else 'not_assessed'}


def _metrics(root, integrity, interaction, capture):
    entry = integrity['game_metrics']
    if not entry['exists'] or entry['status'] == 'failed':
        return {'status': 'not_assessed', 'metrics': []}
    try:
        data = json.loads((root / entry['name']).read_text(encoding='utf-8'))
        if str(data.get('capture_id')) != str(capture.id) or str(data.get('trial_id')) != str(capture.trial_id):
            entry['status'] = 'failed'
            entry['identity_match'] = False
            return {'status': 'failed', 'metrics': [], 'reason': 'metric identity mismatch'}
        entry['identity_match'] = True
        metrics = []
        def walk(value, location):
            if isinstance(value, dict) and 'metric_name' in value and 'quality_status' in value:
                metric = {**value, 'location': location}
                if metric.get('quality_status') == 'partial' and not metric.get('unavailable_reason'):
                    reasons = []
                    if interaction['tracking_interruptions']['loss_count']:
                        reasons.append('tracking_loss_events')
                    if interaction['trajectory_gap_ms']['max'] and interaction['trajectory_gap_ms']['max'] > 250:
                        reasons.append('sample_gap_over_250_ms')
                    metric['derived_partial_reasons'] = reasons or ['source_history_or_trajectory_partial; inspect events and algorithm']
                metrics.append(metric)
            elif isinstance(value, dict):
                for key, child in value.items():
                    walk(child, location + '/' + str(key))
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    walk(child, location + '/' + str(index))
        walk(data, '')
        return {'status': entry['status'], 'metrics': metrics}
    except (ValueError, OSError, TypeError):
        return {'status': 'failed', 'metrics': []}


def _usability(integrity, temporal, spatial, interaction, pose, hand):
    def item(status, reason, evidence, limitations):
        return {'status': status, 'reason': reason, 'evidence': evidence, 'limitations': limitations}
    def available(*names):
        return all(integrity[name]['status'] == 'complete' for name in names)
    game = interaction['game_key']
    return {
        'event_analysis': item('usable' if available('events') and interaction['event_count'] else 'not_assessed',
            'event artifact available' if available('events') else 'events unavailable or integrity unverified', {'count': interaction['event_count']}, ['Interpret events in context of capture completeness.']),
        'trajectory_analysis': item('partial' if available('interaction_samples') and interaction['sample_count'] else 'not_assessed',
            'samples available with possible gaps; drawing samples are accepted points only', {'count': interaction['sample_count']}, ['Not a continuous hand trajectory for free drawing.']),
        'stroke_analysis': item('not_applicable' if game == 'glowing_flower' else 'partial' if game == 'free_drawing' and available('events','interaction_samples') else 'not_assessed',
            'flower has no strokes' if game == 'glowing_flower' else 'requires reconstruction and review', {'strokes': interaction['stroke_count']}, ['Accepted drawing points only.']),
        'tracking_performance_analysis': item('usable' if available('frames') and pose['attempted_inference_count'] and hand['attempted_inference_count'] else 'not_assessed',
            'per-model statuses recorded' if available('frames') else 'frame artifact unavailable or integrity unverified', {'pose_attempts': pose['attempted_inference_count'], 'hand_attempts': hand['attempted_inference_count']}, ['Detection is not clinical accuracy.']),
        'landmark_spatial_analysis': item('partial' if available('landmarks') and spatial['pose']['count'] + spatial['hand']['count'] else 'not_assessed',
            'raw coordinates available for review', {'pose_count': spatial['pose']['count'], 'hand_count': spatial['hand']['count']}, ['No ground truth.']),
        'internal_temporal_analysis': item('usable' if available('frames') and temporal['observation_count'] > 1 and not temporal['timestamp_reversals'] else 'partial' if available('frames') else 'not_assessed',
            'capture timestamps available', {'observations': temporal['observation_count'], 'reversals': temporal['timestamp_reversals']}, ['Does not establish encoded video synchronization.']),
        'video_alignment_analysis': item('not_assessed', 'encoded PTS mapping and alignment error unavailable', {}, ['Frame-perfect alignment cannot be claimed.'])}


def _read_quality_manifest(root):
    """Validate source entries without coercing values or changing the manifest."""
    try:
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        return {}, {}, [f'manifest: cannot read JSON ({type(exc).__name__})']
    if not isinstance(manifest, dict):
        return {}, {}, ['manifest: expected a JSON object']
    artifacts = manifest.get('artifacts')
    if not isinstance(artifacts, list):
        return manifest, {}, ['manifest.artifacts: expected an array']
    entries, errors = {}, []
    allowed = set(NAMES) | {'video', 'tracking_video'}
    for index, entry in enumerate(artifacts):
        location = f'manifest.artifacts[{index}]'
        if not isinstance(entry, dict):
            errors.append(f'{location}: expected an object')
            continue
        kind = entry.get('kind')
        if not isinstance(kind, str) or kind not in allowed:
            errors.append(f'{location}.kind: expected a supported artifact kind string')
            continue
        invalid = [key for key in ('name', 'status', 'sha256')
                   if entry.get(key) is not None and not isinstance(entry[key], str)]
        invalid += [key for key in ('size_bytes', 'record_count') if entry.get(key) is not None
                    and (type(entry[key]) is not int or entry[key] < 0)]
        if 'required' in entry and type(entry['required']) is not bool:
            invalid.append('required')
        if invalid:
            errors.append(f'{location}: invalid metadata fields: {", ".join(invalid)}')
            continue
        if kind in entries:
            errors.append(f'{location}.kind: duplicate artifact kind {kind}')
            continue
        entries[kind] = entry
    return manifest, entries, errors


def assess_capture_quality(capture, root) -> QualityReport:
    """Return a report without modifying capture metadata, artifacts, or the database."""
    if getattr(capture, 'status', None) == 'recording':
        raise ValueError('Capture is still recording; quality assessment is not ready')
    root = Path(root)
    summary = getattr(capture, 'artifact_summary', None) or {}
    config = getattr(capture, 'model_config_info', None) or {}
    summary = summary if isinstance(summary, dict) else {}
    config = config if isinstance(config, dict) else {}
    manifest, entries, manifest_errors = _read_quality_manifest(root)
    version = getattr(capture, 'capture_schema_version', 1) or 1
    requested = {'frames': bool(getattr(capture, 'record_landmarks', False)), 'landmarks': bool(getattr(capture, 'record_landmarks', False)),
                 'video': bool(getattr(capture, 'record_video', False)), 'tracking_video': bool(config.get('record_tracking_video') or entries.get('tracking_video', {}).get('required')),
                 'events': version == 3, 'interaction_samples': version == 3, 'game_metrics': version == 3, 'manifest': True}
    integrity = {kind: _artifact(root, kind, required, summary, entries) for kind, required in requested.items()}
    if manifest_errors:
        integrity['manifest']['status'] = 'failed'
        integrity['manifest']['schema_valid'] = False
        integrity['manifest']['validation_errors'] = manifest_errors
    for kind, data in (('manifest', manifest),):
        if data and any(str(data.get(k)) != str(v) for k, v in (('capture_id', capture.id), ('session_id', capture.session_id), ('trial_id', capture.trial_id))):
            integrity[kind]['status'] = 'failed'
            integrity[kind]['identity_match'] = False
        elif data:
            integrity[kind]['identity_match'] = True
    frames = _rows(root, 'frames', integrity)
    landmarks = _rows(root, 'landmarks', integrity)
    events = _rows(root, 'events', integrity)
    samples = _rows(root, 'interaction_samples', integrity)
    timestamps = [r.get('timestamp_ms') for r in frames if isinstance(r.get('timestamp_ms'), (int, float))]
    duration = timestamps[-1] - timestamps[0] if len(timestamps) > 1 else None
    pose, hand = (_model_quality(frames, model, duration) for model in ('pose', 'hand'))
    temporal = _temporal(frames, capture)
    spatial = _spatial(landmarks)
    interaction = _interaction(events, samples, frames, config.get('exercise_code') or config.get('game_key'))
    stream_checks = {kind: _stream_checks(rows, capture, kind in ('events', 'interaction_samples')) for kind, rows in
                     (('frames', frames), ('landmarks', landmarks), ('events', events), ('interaction_samples', samples))}
    temporal['streams'] = stream_checks
    warnings = manifest_errors + [f'{kind}: {warning}' for kind, data in integrity.items() for warning in data['decode'].get('warnings', [])]
    warnings.append('Video alignment error is unmeasured; source media time is not encoded PTS.')
    usability = _usability(integrity, temporal, spatial, interaction, pose, hand)
    for kind, purposes in {'frames': ('tracking_performance_analysis', 'internal_temporal_analysis'),
                           'landmarks': ('landmark_spatial_analysis',), 'events': ('event_analysis', 'stroke_analysis'),
                           'interaction_samples': ('trajectory_analysis', 'stroke_analysis')}.items():
        check = stream_checks[kind]
        if check['identity_mismatches'] or check['timestamp_reversals'] or check['sequence_mismatches']:
            for purpose in purposes:
                if usability[purpose]['status'] not in ('not_applicable', 'not_assessed'):
                    usability[purpose]['status'] = 'partial'
                    usability[purpose]['reason'] = f'{kind} identity or ordering needs review'
    return {'quality_policy_version': '1', 'generated_at': datetime.now(timezone.utc).isoformat(),
            'capture_id': str(capture.id), 'session_id': capture.session_id, 'trial_id': capture.trial_id,
            'source_type': capture.source_type, 'input_fingerprints': {k: v['actual_sha256'] for k,v in integrity.items()},
            'artifact_integrity': integrity, 'pose_quality': pose, 'hand_quality': hand,
            'landmark_spatial_quality': spatial, 'temporal_quality': temporal, 'interaction_quality': interaction,
            'metrics_quality': _metrics(root, integrity, interaction, capture),
            'research_usability': usability,
            'warnings': warnings, 'exclusion_reasons': [],
            'limitations': ['No automatic exclusion or clinical interpretation.', 'Delegate is metadata and does not prove physical hardware.'],
            'delegates': config.get('delegates')}
