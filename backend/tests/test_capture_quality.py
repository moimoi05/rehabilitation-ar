"""Focused tests for read-only capture quality reports."""
import hashlib
import json
from types import SimpleNamespace
from uuid import uuid4

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from app.capture_storage import FRAME_SCHEMA, LANDMARK_SCHEMA
from app.capture_game_storage import EVENT_SCHEMA, SAMPLE_SCHEMA


def write_rows(path, schema, rows):
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), path)


@pytest.fixture
def quality_fixture(tmp_path):
    capture_id = str(uuid4())
    root = tmp_path / capture_id
    root.mkdir()
    base = dict(capture_id=capture_id, patient_id=1, session_id=2, trial_id=3)
    statuses = ['detected', 'not_detected', 'error', 'missing_result', 'not_run']
    frames = [dict(base, frame_id=i, source_frame_id=i, source_observation_id=i,
        timestamp_ms=float(i * 100), video_media_time_ms=float(i * 100),
        inference_performed=i != 4, pose_inference_performed=i != 4,
        hand_inference_performed=i != 4, pose_inference_status=status,
        hand_inference_status=status, pose_inference_ms=float(i + 1) if i != 4 else None,
        hand_inference_ms=float(i + 1) if i != 4 else None, skipped_frames=0)
        for i, status in enumerate(statuses)]
    write_rows(root / 'frames.parquet', FRAME_SCHEMA, frames)
    write_rows(root / 'landmarks.parquet', LANDMARK_SCHEMA, [])
    events = [dict(base, game_key='free_drawing', sequence=i, timestamp_ms=float(t),
        event_type=kind, event_id=str(i), event_schema_version=1,
        payload_json=json.dumps(payload)) for i, (t, kind, payload) in enumerate([
            (0, 'GAME_STARTED', {'tracking_usable': True}),
            (100, 'TRACKING_LOST', {}),
            (300, 'GAME_COMPLETED', {'reason': 'stopped'}),
        ])]
    write_rows(root / 'events.parquet', EVENT_SCHEMA, events)
    samples = [dict(base, game_key='free_drawing', sequence=0, timestamp_ms=100.0,
        source_timestamp_ms=100.0, source_observation_id=1, sample_type='drawing_stroke_point',
        sample_id='0', sample_schema_version=1,
        payload_json=json.dumps({'stroke_id': 1, 'x': 0.2, 'y': 0.3, 'usable': True, 'freshness': 'fresh'}))]
    write_rows(root / 'interaction_samples.parquet', SAMPLE_SCHEMA, samples)
    metrics = {'capture_id': capture_id, 'trial_id': 3, 'metric_schema_version': 1, 'algorithm_version': 'game-metrics-2d-v1',
        'trial': {'total_stroke_length': {'metric_name': 'total_stroke_length', 'value': 1.0, 'unit': 'px', 'algorithm_version': 'game-metrics-2d-v1',
            'sample_count': 1, 'quality_status': 'partial', 'unavailable_reason': None}}}
    (root / 'game_metrics.json').write_text(json.dumps(metrics), encoding='utf-8')
    files = [('frames', 'frames.parquet'), ('landmarks', 'landmarks.parquet'),
             ('events', 'events.parquet'), ('interaction_samples', 'interaction_samples.parquet'),
             ('game_metrics', 'game_metrics.json')]
    artifacts = [dict(kind=kind, name=name, required=True, status='complete',
        size_bytes=(root/name).stat().st_size, sha256=hashlib.sha256((root/name).read_bytes()).hexdigest())
        for kind, name in files]
    manifest = dict(base, source_type='webcam', status='complete', duration_ms=300,
        game_started_at_ms=0, game_ended_at_ms=300, configuration={'game_key':'free_drawing'},
        artifacts=artifacts, synchronization={'encoded_pts_mapping':'unavailable'})
    (root / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    capture = SimpleNamespace(id=capture_id, patient_id=1, session_id=2, trial_id=3,
        source_type='webcam', status='complete', capture_schema_version=3,
        record_landmarks=True, record_video=False, model_config_info={'exercise_code':'free_drawing'},
        artifact_summary={}, duration_ms=300)
    return capture, root


def test_model_denominators_and_linear_percentiles():
    from app.capture_quality import _model_quality
    statuses = ['detected', 'not_detected', 'error', 'missing_result', 'not_run']
    rows = [{'pose_inference_status': status, 'pose_inference_ms': float(i), 'skipped_frames': 0}
            for i, status in enumerate(statuses)]
    quality = _model_quality(rows, 'pose', 1000)
    assert quality['detection_rate'] == 0.5
    assert quality['result_coverage'] == 0.5
    assert quality['error_rate'] == quality['missing_result_rate'] == 0.25
    assert quality['attempted_inference_count'] == 4
    assert quality['latency_p95_ms'] == pytest.approx(3.8)
    empty = _model_quality([{'pose_inference_status': 'not_run'}], 'pose', 0)
    assert empty['detection_rate'] is None and empty['detection_rate_reason']
    assert empty['result_coverage'] is None and empty['attempted_denominator_reason']


def test_timestamp_duplicates_and_reversal():
    from app.capture_quality import _temporal
    frames = [dict(timestamp_ms=t, frame_id=i, source_observation_id=i,
                   source_frame_id=i, video_media_time_ms=t) for i, t in enumerate([0, 10, 10, 5])]
    result = _temporal(frames, SimpleNamespace(model_config_info={}))
    assert result['duplicate_timestamps'] == 1
    assert result['timestamp_reversals'] == 1
    assert result['video_alignment']['status'] == 'not_assessed'


def test_checksum_mismatch_and_missing_not_requested(quality_fixture):
    from app.capture_quality import _artifact
    capture, root = quality_fixture
    entry = {'frames': {'name': 'frames.parquet', 'status': 'complete', 'sha256': '0' * 64}}
    assert _artifact(root, 'frames', True, {}, entry)['status'] == 'failed'
    assert _artifact(root, 'video', True, {}, {})['status'] == 'missing'
    assert _artifact(root, 'tracking_video', False, {}, {})['status'] == 'not_requested'



def test_loss_cutoff_linkage_metrics_and_determinism(quality_fixture):
    from app.capture_quality import assess_capture_quality
    capture, root = quality_fixture
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
    first = assess_capture_quality(capture, root)
    second = assess_capture_quality(capture, root)
    assert first['interaction_quality']['tracking_interruptions']['unusable_duration_ms'] == 200
    assert first['interaction_quality']['tracking_interruptions']['usable_duration_ms'] == 100
    assert first['interaction_quality']['source_observation_linkage']['matched'] == 1
    assert first['metrics_quality']['metrics'][0]['derived_partial_reasons']
    assert first['interaction_quality']['continuous_hand_trajectory'] == 'not_recorded'
    first.pop('generated_at'); second.pop('generated_at')
    assert first == second
    assert before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}


def test_old_schema_and_flower_strokes_not_applicable(quality_fixture):
    from app.capture_quality import assess_capture_quality
    capture, root = quality_fixture
    capture.model_config_info = {'exercise_code': 'glowing_flower'}
    report = assess_capture_quality(capture, root)
    assert report['research_usability']['stroke_analysis']['status'] == 'not_applicable'
    capture.capture_schema_version = 1
    (root / 'events.parquet').unlink()
    report = assess_capture_quality(capture, root)
    assert report['artifact_integrity']['events']['status'] == 'not_requested'


def test_api_does_not_write_db_and_recording_is_not_ready(quality_fixture, tmp_path, monkeypatch):
    from app import captures
    from app.db import get_db
    from app.main import app
    capture, root = quality_fixture
    class ReadOnlyDatabase:
        def __getattr__(self, name):
            raise AssertionError(f'unexpected database operation: {name}')
    monkeypatch.setenv('REHAB_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(captures, 'get_capture', lambda db, capture_id: capture)
    app.dependency_overrides[get_db] = lambda: ReadOnlyDatabase()
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
    try:
        with TestClient(app) as client:
            response = client.get(f'/api/captures/{capture.id}/quality')
            assert response.status_code == 200
            assert response.json()['capture_id'] == capture.id
            capture.status = 'recording'
            assert client.get(f'/api/captures/{capture.id}/quality').status_code == 409
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}


def test_incomplete_capture_null_timestamps_does_not_raise(quality_fixture):
    from app.capture_quality import assess_capture_quality
    capture, root = quality_fixture
    capture.status = 'incomplete'
    rows = pq.read_table(root / 'frames.parquet').to_pylist()
    rows[0]['timestamp_ms'] = None
    write_rows(root / 'frames.parquet', FRAME_SCHEMA, rows)
    manifest = json.loads((root / 'manifest.json').read_text())
    frame = next(x for x in manifest['artifacts'] if x['kind'] == 'frames')
    frame.update(size_bytes=(root / 'frames.parquet').stat().st_size,
                 sha256=hashlib.sha256((root / 'frames.parquet').read_bytes()).hexdigest())
    (root / 'manifest.json').write_text(json.dumps(manifest))
    report = assess_capture_quality(capture, root)
    assert report['temporal_quality']['observation_count'] == len(rows)


@pytest.mark.parametrize('manifest', [[], {'artifacts': 'bad'}, {'capture_id': 'wrong', 'session_id': 2, 'trial_id': 3, 'artifacts': []}])
def test_bad_manifest_fails_integrity(quality_fixture, manifest):
    from app.capture_quality import assess_capture_quality
    capture, root = quality_fixture
    (root / 'manifest.json').write_text(json.dumps(manifest))
    report = assess_capture_quality(capture, root)
    assert report['artifact_integrity']['manifest']['status'] == 'failed'


def test_unknown_inference_prevents_false_complete_rates():
    from app.capture_quality import _model_quality
    rows = [dict(pose_inference_status='detected', pose_inference_performed=True),
            dict(pose_inference_status=None, pose_inference_performed=True)]
    result = _model_quality(rows, 'pose', 100)
    assert result['result_coverage'] is None
    assert result['error_rate'] is None
    assert result['missing_result_rate'] is None


def test_row_count_mismatch_and_foreign_identity_gate_usability(quality_fixture):
    from app.capture_quality import assess_capture_quality
    capture, root = quality_fixture
    manifest = json.loads((root / 'manifest.json').read_text())
    frame = next(x for x in manifest['artifacts'] if x['kind'] == 'frames')
    frame['record_count'] = 999
    (root / 'manifest.json').write_text(json.dumps(manifest))
    report = assess_capture_quality(capture, root)
    assert report['artifact_integrity']['frames']['status'] == 'failed'
    assert report['research_usability']['tracking_performance_analysis']['status'] != 'usable'
    frame['record_count'] = 5
    rows = pq.read_table(root / 'events.parquet').to_pylist()
    rows[0]['trial_id'] = 999
    write_rows(root / 'events.parquet', EVENT_SCHEMA, rows)
    event = next(x for x in manifest['artifacts'] if x['kind'] == 'events')
    event.update(size_bytes=(root / 'events.parquet').stat().st_size,
                 sha256=hashlib.sha256((root / 'events.parquet').read_bytes()).hexdigest())
    (root / 'manifest.json').write_text(json.dumps(manifest))
    report = assess_capture_quality(capture, root)
    assert report['temporal_quality']['streams']['events']['identity_mismatches'] == 1
    assert report['research_usability']['event_analysis']['status'] != 'usable'



def test_decoder_warning_addresses_are_normalized(monkeypatch, tmp_path):
    from app import capture_quality
    addresses = iter(['000001abcDEF9876', '000002feda543210'])
    monkeypatch.setattr(capture_quality, 'executable', lambda name: 'mock-decoder')
    def fake_run(*args, **kwargs):
        address = next(addresses)
        return SimpleNamespace(returncode=0, stderr=f'[null @ {address}] non monotonically increasing dts\n')
    monkeypatch.setattr(capture_quality.subprocess, 'run', fake_run)
    first = capture_quality._decode(tmp_path / 'video.webm')
    second = capture_quality._decode(tmp_path / 'video.webm')
    assert first == second
    assert first['status'] == 'complete'
    assert 'non monotonically increasing dts' in first['warnings'][0]


@pytest.mark.parametrize('bad_entry', [{'kind': []}, {}, 'frames', None, {'kind': 'frames', 'name': []}])
def test_malformed_manifest_entry_api_is_read_only(quality_fixture, tmp_path, monkeypatch, bad_entry):
    from app import captures
    from app.db import get_db
    from app.main import app
    capture, root = quality_fixture
    manifest = json.loads((root / 'manifest.json').read_text())
    manifest['artifacts'].append(bad_entry)
    (root / 'manifest.json').write_text(json.dumps(manifest))
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
    class ReadOnlyDatabase:
        def __getattr__(self, name):
            raise AssertionError(f'unexpected database operation: {name}')
    monkeypatch.setenv('REHAB_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(captures, 'get_capture', lambda db, capture_id: capture)
    app.dependency_overrides[get_db] = lambda: ReadOnlyDatabase()
    try:
        with TestClient(app) as client:
            response = client.get(f'/api/captures/{capture.id}/quality')
        assert response.status_code == 200
        report = response.json()
        assert report['artifact_integrity']['manifest']['status'] == 'failed'
        assert any('artifacts[5]' in warning for warning in report['warnings'])
        assert report['artifact_integrity']['frames']['status'] == 'complete'
        assert report['temporal_quality']['observation_count'] == 5
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}


@pytest.mark.parametrize('raw_manifest', ['{', '[]', '{"artifacts": {}}'])
def test_unreadable_manifest_preserves_independent_assessment(quality_fixture, raw_manifest):
    from app.capture_quality import assess_capture_quality
    capture, root = quality_fixture
    (root / 'manifest.json').write_text(raw_manifest)
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
    report = assess_capture_quality(capture, root)
    assert report['artifact_integrity']['manifest']['status'] == 'failed'
    assert any('manifest' in warning for warning in report['warnings'])
    assert report['artifact_integrity']['frames']['schema_valid'] is True
    assert report['temporal_quality']['observation_count'] == 5
    assert before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
