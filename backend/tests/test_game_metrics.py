"""Deterministic metric fixtures, with no clinical interpretations or external data."""
import pytest

from app.game_metrics import compute_game_metrics


def event(kind, timestamp, **payload):
    return dict(event_type=kind, timestamp_ms=timestamp, payload=payload)


def sample(kind, timestamp, x, y, **payload):
    return dict(sample_type=kind, timestamp_ms=timestamp, payload=dict(x=x, y=y,
        coordinate_space='logical_canvas_px', width=1000, height=500,
        usable=True, freshness='fresh', **payload))


def compute(events, samples=(), game_key='free_drawing'):
    return compute_game_metrics(iter(events), iter(samples), game_key=game_key,
        capture_id='capture', trial_id=3)


def value(metrics, name):
    return metrics[name]['value']


def test_flower_pixels_touch_counts_and_missing_onset():
    events = [event('GAME_STARTED', 10, tracking_usable=True),
        event('TARGET_SPAWNED', 10, target_id='target-1', target_sequence=1,
            target_x=.5, target_y=.5, target_radius=20, coordinate_space='display_normalized', width=1000, height=500),
        event('TARGET_TOUCHED', 110, target_id='target-1', cursor_x=.503, cursor_y=.508),
        event('TARGET_SPAWNED', 110, target_id='target-2', target_sequence=2,
            target_x=.7, target_y=.5, coordinate_space='display_normalized', width=1000, height=500),
        event('TRACKING_LOST', 150, target_id='target-2'),
        event('GAME_COMPLETED', 210, score=1, gameplay_elapsed_ms=150)]
    samples = [dict(sample('flower_cursor', t, x, y, target_id='target-1'),
        payload=dict(x=x, y=y, target_id='target-1', coordinate_space='display_normalized',
            width=1000, height=500, usable=True, freshness='fresh'))
        for t, x, y in [(20, .5, .5), (100, .503, .508)]]
    result = compute(events, samples, 'glowing_flower')
    trial, target = result['trial'], result['targets'][0]['metrics']
    assert value(trial, 'spawned_target_count') == 2
    assert value(trial, 'completed_target_count') == value(trial, 'score') == 1
    assert value(trial, 'completion_rate') == .5
    assert value(trial, 'tracking_coverage') == .7
    assert value(target, 'time_to_touch_ms') == 100
    assert value(target, 'endpoint_error') == pytest.approx(5)
    assert value(target, 'path_length') == pytest.approx(5)
    assert target['path_length']['unit'] == 'px'
    assert target['reaction_time_ms']['value'] is None
    assert target['reaction_time_ms']['unavailable_reason'] == 'movement_onset_algorithm_not_implemented'
    assert value(result['targets'][1]['metrics'], 'tracking_loss_count') == 1
    assert value(result['targets'][1]['metrics'], 'success') is False
    assert result['targets'][1]['metrics']['time_to_touch_ms']['value'] is None


def test_drawing_history_survives_undo_clear_and_drag_uses_offsets():
    events = [event('GAME_STARTED', 1, tracking_usable=True),
        event('STROKE_STARTED', 10, stroke_id=1),
        event('STROKE_COMPLETED', 200, stroke_id=1, reason='user_action', interrupted=False),
        event('STROKE_GRABBED', 210, stroke_id=1, drag_id='drag-1', offset_x=0, offset_y=0,
            x=100, y=100, coordinate_space='logical_canvas_px', width=1000, height=500),
        event('STROKE_RELEASED', 260, stroke_id=1, drag_id='drag-1', offset_x=6, offset_y=8),
        event('UNDO', 270, stroke_id=1), event('CLEAR_CANVAS', 280, stroke_ids=[]),
        event('GAME_COMPLETED', 300)]
    samples = [sample('drawing_stroke_point', 10, 100, 100, stroke_id=1),
        sample('drawing_stroke_point', 110, 103, 104, stroke_id=1),
        sample('drawing_drag_point', 230, 103, 104, stroke_id=1, drag_id='drag-1', offset_x=3, offset_y=4),
        sample('drawing_drag_point', 250, 106, 108, stroke_id=1, drag_id='drag-1', offset_x=6, offset_y=8)]
    result = compute(events, samples)
    stroke, drag, trial = result['strokes'][0]['metrics'], result['drags'][0]['metrics'], result['trial']
    assert value(stroke, 'stroke_duration_ms') == 100  # source sample clock, not delayed completion callback
    assert value(stroke, 'stroke_length') == 5
    assert value(stroke, 'stroke_mean_speed') == 50
    assert value(stroke, 'stroke_point_count') == 2
    assert value(drag, 'drag_distance') == 10
    assert value(drag, 'drag_duration_ms') == 50
    assert value(drag, 'drag_completed') is True
    assert value(trial, 'completed_stroke_count') == 1
    assert value(trial, 'undo_count') == value(trial, 'clear_count') == 1
    assert value(trial, 'total_stroke_length') == 5
    assert value(trial, 'active_drawing_duration_ms') == 100


def test_tracking_loss_geometry_and_large_gap_never_bridge_paths():
    events = [event('GAME_STARTED', 1, tracking_usable=True), event('STROKE_STARTED', 10, stroke_id=1),
        event('TRACKING_LOST', 60), event('TRACKING_RECOVERED', 90),
        event('GEOMETRY_CHANGED', 170),
        event('STROKE_COMPLETED', 700, stroke_id=1, reason='tracking_lost', interrupted=True),
        event('GAME_COMPLETED', 800)]
    samples = [sample('drawing_stroke_point', t, x, 0, stroke_id=1)
        for t, x in [(10, 0), (50, 5), (100, 100), (150, 105), (200, 200), (600, 300)]]
    result = compute(events, samples)
    stroke = result['strokes'][0]['metrics']
    assert value(stroke, 'stroke_length') == 10
    assert stroke['stroke_length']['quality_status'] == 'partial'
    assert value(stroke, 'stroke_mean_speed') == pytest.approx(10 / .09)
    assert value(stroke, 'stroke_interrupted') is True
    assert value(stroke, 'interruption_reason') == 'tracking_lost'
    assert value(result['trial'], 'tracking_interrupted_stroke_count') == 1


def test_missing_samples_are_null_and_generator_is_consumed_once():
    events = [event('GAME_STARTED', 1, tracking_usable=False),
        event('STROKE_STARTED', 10, stroke_id=1),
        event('STROKE_COMPLETED', 20, stroke_id=1, reason='tracking_lost', interrupted=True),
        event('GAME_COMPLETED', 30)]
    result = compute(events)
    stroke = result['strokes'][0]['metrics']
    for name in ['stroke_duration_ms', 'stroke_length', 'stroke_mean_speed', 'stroke_smoothness']:
        assert stroke[name]['value'] is None
        assert stroke[name]['quality_status'] == 'unavailable'
        assert stroke[name]['unavailable_reason']
    assert value(result['trial'], 'total_stroke_length') is None
    assert compute([])['trial']['tracking_coverage']['value'] is None


def test_invalid_or_different_coordinate_frames_do_not_form_a_segment():
    events = [event('GAME_STARTED', 1), event('STROKE_STARTED', 10, stroke_id=1),
        event('STROKE_COMPLETED', 100, stroke_id=1, reason='user_action', interrupted=False),
        event('GAME_COMPLETED', 110)]
    points = [sample('drawing_stroke_point', 10, 0, 0, stroke_id=1),
        sample('drawing_stroke_point', 20, float('nan'), 0, stroke_id=1),
        sample('drawing_stroke_point', 30, 3, 4, stroke_id=1)]
    points[2]['payload']['width'] = 2000
    result = compute(events, points)
    assert value(result['strokes'][0]['metrics'], 'stroke_length') is None


def test_flower_endpoint_uses_latest_geometry_snapshot_before_touch():
    geometry = dict(target_id='target-1', target_sequence=1, target_x=.5, target_y=.5,
        coordinate_space='display_normalized', width=1000, height=500)
    events = [event('GAME_STARTED', 1, tracking_usable=True), event('TARGET_SPAWNED', 2, **geometry),
        event('GEOMETRY_PAUSED', 10, **{**geometry, 'width': 2000, 'height': 1000}),
        event('GEOMETRY_RESUMED', 20, **{**geometry, 'width': 2000, 'height': 1000}),
        event('TARGET_TOUCHED', 30, target_id='target-1', cursor_x=.503, cursor_y=.504),
        event('GAME_COMPLETED', 40, score=1, gameplay_elapsed_ms=20)]
    result = compute(events, game_key='glowing_flower')
    assert value(result['targets'][0]['metrics'], 'endpoint_error') == pytest.approx((6 ** 2 + 4 ** 2) ** .5)


def test_no_stroke_samples_does_not_report_measured_zero_points():
    result = compute([event('GAME_STARTED', 1), event('STROKE_STARTED', 2, stroke_id=1),
        event('STROKE_COMPLETED', 20, stroke_id=1, point_count=2, interrupted=False, reason='user_action'),
        event('GAME_COMPLETED', 30)])
    metric = result['strokes'][0]['metrics']['stroke_point_count']
    assert metric['value'] is None
    assert metric['unavailable_reason'] == 'accepted_samples_unavailable'


def test_metrics_read_real_parquet_and_record_source_checksums(tmp_path):
    import hashlib
    import json
    from types import SimpleNamespace
    from uuid import uuid4

    from app.capture_game_storage import convert_game_data, write_game_metrics
    from app.capture_schemas import GameBatch

    identity = str(uuid4())
    events = [event('GAME_STARTED', 1, tracking_usable=True), event('STROKE_STARTED', 10, stroke_id=1),
        event('STROKE_COMPLETED', 120, stroke_id=1, point_count=2, reason='user_action', interrupted=False),
        event('GAME_COMPLETED', 130)]
    samples = [sample('drawing_stroke_point', 10, 0, 0, stroke_id=1), sample('drawing_stroke_point', 110, 3, 4, stroke_id=1)]
    common = dict(capture_id=identity, trial_id=3, game_key='free_drawing', frame_id=None, source_observation_id=None)
    events = [dict(**common, **row, event_id=f'{identity}:event:{i}', event_schema_version=1, sequence=i) for i, row in enumerate(events)]
    samples = [dict(**common, **row, sample_id=f'{identity}:sample:{i}', sample_schema_version=1, sequence=i) for i, row in enumerate(samples)]
    batch = GameBatch(batch_index=0, events=events, samples=samples)
    staged = tmp_path / '0.json'
    staged.write_text(batch.model_dump_json(), encoding='utf-8')
    staged.with_suffix('.sha256').write_text(hashlib.sha256(staged.read_bytes()).hexdigest())
    summary = convert_game_data(tmp_path, [staged], identity, 1, 2, 3, 'free_drawing', 140)
    metrics_summary = write_game_metrics(tmp_path, SimpleNamespace(id=identity, trial_id=3, model_config_info={'exercise_code': 'free_drawing'}), summary)
    output = json.loads((tmp_path / 'game_metrics.json').read_text(encoding='utf-8'))
    assert value(output['trial'], 'total_stroke_length') == 5
    for filename, checksum in output['source_artifact_checksums'].items():
        assert hashlib.sha256((tmp_path / filename).read_bytes()).hexdigest() == checksum
    assert metrics_summary['game_metrics_sha256'] == hashlib.sha256((tmp_path / 'game_metrics.json').read_bytes()).hexdigest()
