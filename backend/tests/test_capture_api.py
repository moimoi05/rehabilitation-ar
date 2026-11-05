"""Capture integration tests: explicit PostgreSQL, rolled-back DB, private temp files."""
import csv
import hashlib
import io
import json
import os
from types import SimpleNamespace
from uuid import uuid4

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app import models, captures
from app.db import get_db
from app.main import app


def test_capture_parquet_preview_is_bounded_and_checks_artifact(tmp_path, monkeypatch):
    identity = uuid4()
    folder = tmp_path / str(identity)
    folder.mkdir()
    pq.write_table(pa.table({'frame_id': list(range(15)), 'pose_detected': [True] * 15}), folder / 'frames.parquet')
    monkeypatch.setenv('REHAB_DATA_DIR', str(tmp_path))
    capture = SimpleNamespace(status='complete', artifact_summary={'frames_status': 'complete'})
    monkeypatch.setattr(captures, 'get_capture', lambda db, capture_id: capture)
    app.dependency_overrides[get_db] = lambda: None
    try:
        with TestClient(app) as client:
            response = client.get(f'/api/captures/{identity}/preview/frames')
            assert response.status_code == 200
            assert response.json() == {'columns': ['frame_id', 'pose_detected'],
                'rows': [{'frame_id': i, 'pose_detected': True} for i in range(10)], 'total_rows': 15}
            assert client.get(f'/api/captures/{identity}/preview/landmarks').status_code == 404
            assert client.get(f'/api/captures/{identity}/preview/video').status_code == 404
            capture.status = 'recording'
            assert client.get(f'/api/captures/{identity}/preview/frames').status_code == 404
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def capture_context(tmp_path, monkeypatch):
    url = os.getenv('TEST_DATABASE_URL')
    if not url:
        pytest.skip('TEST_DATABASE_URL is required for PostgreSQL capture integration tests')
    if not url.startswith('postgresql+psycopg://'):
        pytest.fail('Tests require PostgreSQL through psycopg')
    monkeypatch.setenv('REHAB_DATA_DIR', str(tmp_path))
    engine = create_engine(url)
    connection = engine.connect()
    transaction = connection.begin()
    db = Session(bind=connection, join_transaction_mode='create_savepoint', expire_on_commit=False)
    def override_db():
        yield db
    app.dependency_overrides[get_db] = override_db
    try:
        first = models.Patient(research_code='TEST-' + uuid4().hex, affected_side='left', dominant_hand='right')
        other = models.Patient(research_code='TEST-' + uuid4().hex, affected_side='right', dominant_hand='right')
        db.add_all([first, other]); db.flush()
        first_session = models.Session(patient_id=first.id, affected_side='left', session_type='assessment', status='draft')
        other_session = models.Session(patient_id=other.id, affected_side='right', session_type='assessment', status='draft')
        db.add_all([first_session, other_session]); db.flush()
        first_trial = models.Trial(session_id=first_session.id, exercise_code='test')
        other_trial = models.Trial(session_id=other_session.id, exercise_code='test')
        db.add_all([first_trial, other_trial]); db.flush()
        with TestClient(app) as client:
            yield client, tmp_path, (first.id, first_session.id, first_trial.id), (other.id, other_session.id, other_trial.id)
    finally:
        app.dependency_overrides.clear()
        db.close()
        transaction.rollback()
        connection.close()
        engine.dispose()


def create_payload(ids):
    patient_id, session_id, trial_id = ids
    return dict(patient_id=patient_id, session_id=session_id, trial_id=trial_id,
                source_type='pre_recorded_video', record_landmarks=True, record_video=True,
                consent_landmarks=True, consent_video=True, started_at_utc='2026-01-01T00:00:00Z',
                start_performance_ms=123.5, video_mime_type='video/mp4', width=1920, height=1080,
                model_config={'pose': 'test'})


def create_capture(client, ids):
    response = client.post('/api/captures', json=create_payload(ids))
    assert response.status_code == 201, response.text
    return response.json()


def frame_batch():
    return {'batch_index': 0, 'frames': [
        {'frame_id': 0, 'source_frame_id': 2, 'timestamp_ms': 25.0, 'video_media_time_ms': 25.0,
         'inference_performed': False, 'pose_detected': None, 'hand_detected': None,
         'inference_ms': None, 'skipped_frames': 1, 'landmarks': []},
        {'frame_id': 1, 'source_frame_id': 3, 'timestamp_ms': 55.0, 'video_media_time_ms': 55.0,
         'inference_performed': True, 'pose_detected': False, 'hand_detected': False, 'landmarks': []},
        {'frame_id': 2, 'source_frame_id': 4, 'timestamp_ms': 90.0, 'video_media_time_ms': 90.0,
         'inference_performed': True, 'pose_detected': True, 'hand_detected': False,
         'landmarks': [
             {'landmark_source': 'pose', 'landmark_index': 11, 'landmark_name': 'left_shoulder',
              'x': .1, 'y': .2, 'z': -.3, 'coordinate_space': 'normalized_image',
              'representation': 'raw', 'is_valid': True, 'visibility': .9},
             {'landmark_source': 'pose', 'landmark_index': 11, 'landmark_name': 'left_shoulder',
              'x': .15, 'y': .2, 'z': -.3, 'coordinate_space': 'normalized_image',
              'representation': 'display', 'is_valid': True},
             {'landmark_source': 'pose', 'landmark_index': 11, 'landmark_name': 'left_shoulder',
              'x': 1.5, 'y': 2.5, 'z': -3.5, 'coordinate_space': 'world',
              'representation': 'raw', 'is_valid': False, 'invalid_reason': 'test_invalid'},
         ]},
    ]}


def put_chunk(client, capture_id, index, data, digest=None, content_type='video/mp4'):
    return client.put(f'/api/captures/{capture_id}/video-chunks/{index}', content=data,
                      headers={'Content-Type': content_type, 'X-Chunk-SHA256': digest or hashlib.sha256(data).hexdigest()})


@pytest.mark.parametrize('tracking_chunks,gaps,expected_status,corrupt,tracking_complete', [
    (1, [], 'complete', False, True), (0, ['tracking recorder failed'], 'incomplete', False, False),
    (1, [], 'incomplete', True, True), (0, [], 'incomplete', False, True),
    (1, ['tracking recorder failed'], 'incomplete', False, False), (1, [], 'incomplete', False, False),
])
def test_tracking_video_finalization_and_source_preservation(tmp_path, monkeypatch, tracking_chunks, gaps, expected_status, corrupt, tracking_complete):
    """Exercise the artifact flow using temporary files and no real database."""
    from datetime import datetime, timezone
    identity = str(uuid4())
    capture = models.CaptureRun(id=identity, patient_id=1, session_id=2, trial_id=3,
        source_type='pre_recorded_video', capture_mode='manual', capture_schema_version=2,
        status='recording', record_video=True, record_landmarks=True, consent_video=True,
        consent_landmarks=True, video_mime_type='video/mp4', model_config_info={'record_tracking_video': True},
        started_at_utc=datetime(2026, 1, 1, tzinfo=timezone.utc), start_performance_ms=100,
        lease_expires_at=None)
    class DB:
        def commit(self): pass
        def add(self, _entity): pass
    monkeypatch.setenv('REHAB_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(captures, 'get_capture', lambda db, capture_id, lock=False: capture)
    app.dependency_overrides[get_db] = lambda: DB()
    try:
        with TestClient(app) as client:
            url = f'/api/captures/{identity}'
            assert client.post(f'{url}/landmark-batches', json=frame_batch()).status_code == 200
            assert put_chunk(client, identity, 0, b'original').status_code == 200
            if tracking_chunks:
                start = {'start_performance_ms': 120, 'started_at_utc': '2026-01-01T00:00:00.020Z', 'mime_type': 'video/mp4'}
                assert client.post(f'{url}/tracking-recorder-start', json=start).status_code == 200
                assert client.post(f'{url}/tracking-recorder-start', json=start).status_code == 200
                chunk = b'annotated'
                headers = {'Content-Type': 'video/mp4', 'X-Chunk-SHA256': hashlib.sha256(chunk).hexdigest()}
                assert client.put(f'{url}/tracking-video-chunks/0', content=chunk, headers=headers).status_code == 200
                assert client.put(f'{url}/tracking-video-chunks/0', content=chunk, headers=headers).json()['stored'] is False
                if corrupt:
                    (tmp_path / identity / 'staging' / 'tracking_chunks' / '0.chunk').write_bytes(b'tampered')
            payload = {'expected_batches': 1, 'expected_video_chunks': 1, 'expected_tracking_video_chunks': tracking_chunks,
                'tracking_video_complete': tracking_complete, 'ended_at_utc': '2026-01-01T00:00:01Z', 'duration_ms': 1000, 'known_data_gaps': gaps}
            response = client.post(f'{url}/finalize', json=payload)
            expect_error = corrupt or not tracking_chunks and not gaps and tracking_complete
            assert response.status_code == (409 if expect_error else 200), response.text
            summary = capture.artifact_summary
            assert capture.status == expected_status
            assert client.get(f'{url}/artifacts/video').content == b'original'
            assert client.get(f'{url}/artifacts/frames').status_code == 200
            assert client.get(f'{url}/artifacts/landmarks').status_code == 200
            if tracking_chunks and not corrupt:
                assert client.get(f'{url}/artifacts/tracking_video').content == b'annotated'
                assert summary['tracking_video_sha256'] == hashlib.sha256(b'annotated').hexdigest()
                assert summary['tracking_video_status'] == ('complete' if tracking_complete else 'incomplete')
            else:
                assert summary['tracking_video_status'] == 'failed'
                assert client.get(f'{url}/artifacts/tracking_video').status_code == 404
            manifest = client.get(f'{url}/artifacts/manifest').json()
            assert next(item for item in manifest['artifacts'] if item['kind'] == 'tracking_video')['status'] == summary['tracking_video_status']
            if not expect_error:
                assert client.post(f'{url}/finalize', json=payload).status_code == 200
    finally:
        app.dependency_overrides.pop(get_db, None)


def finalize(client, capture_id, chunks=2, batches=1):
    return client.post(f'/api/captures/{capture_id}/finalize', json={
        'expected_batches': batches, 'expected_video_chunks': chunks,
        'ended_at_utc': '2026-01-01T00:00:01Z', 'duration_ms': 1000})


def test_capture_checks_relationships_and_consent(capture_context):
    client, _, first, other = capture_context
    for changes in ({'patient_id': other[0]}, {'trial_id': other[2]}, {'consent_video': False}, {'consent_landmarks': False}):
        assert client.post('/api/captures', json={**create_payload(first), **changes}).status_code == 422
    result = create_capture(client, first)
    assert (result['patient_id'], result['session_id'], result['trial_id']) == first
    assert result['source_type'] == 'pre_recorded_video' and result['status'] == 'recording'
    listed = client.get(f'/api/sessions/{first[1]}/captures').json()
    assert [row['id'] for row in listed] == [result['id']]
    assert client.get(f'/api/sessions/{other[1]}/captures').json() == []


def test_auto_capture_is_idempotent_only_within_automatic_trial_scope(capture_context):
    client, _, first, _ = capture_context
    db = next(app.dependency_overrides[get_db]())
    trial = db.get(models.Trial, first[2])
    trial.exercise_code, trial.status = 'glowing_flower', 'in_progress'
    db.flush()
    payload = {**create_payload(first), 'capture_mode': 'per_trial', 'capture_schema_version': 2}
    one = client.post('/api/captures', json=payload)
    two = client.post('/api/captures', json=payload)
    assert one.status_code == two.status_code == 201
    assert one.json()['id'] == two.json()['id']
    assert one.json()['capture_mode'] == 'per_trial'
    assert one.json()['model_config_info']['affected_side'] == 'left'
    assert create_capture(client, first)['id'] != one.json()['id']
    assert client.post(f"/api/captures/{one.json()['id']}/landmark-batches", json=frame_batch()).status_code == 422
    assert client.post('/api/captures', json={**payload, 'start_performance_ms': 999}).status_code == 409
    assert client.post(f"/api/captures/{one.json()['id']}/incomplete", json={'reason': 'recorder lost tail', 'known_data_gaps': ['tail unavailable']}).status_code == 200
    assert client.post('/api/captures', json=payload).json()['status'] == 'incomplete'
    assert put_chunk(client, one.json()['id'], 0, b'late').status_code == 409


def test_phase1_manifest_checksums_and_known_gaps_never_complete(capture_context):
    client, root, first, _ = capture_context
    identity = create_capture(client, first)['id']
    assert client.post(f'/api/captures/{identity}/landmark-batches', json=frame_batch()).status_code == 200
    assert put_chunk(client, identity, 0, b'video').status_code == 200
    payload = dict(expected_batches=1, expected_video_chunks=1,
        ended_at_utc='2026-01-01T00:00:01Z', duration_ms=1000,
        game_started_at_ms=10, game_ended_at_ms=900, termination_reason='cancelled',
        known_data_gaps=['queue full at observation 10'])
    response = client.post(f'/api/captures/{identity}/finalize', json=payload)
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'incomplete'
    manifest = json.loads((root / identity / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['status'] == 'incomplete'
    assert manifest['game_ended_at_ms'] == 900
    assert manifest['known_data_gaps'] == payload['known_data_gaps']
    for artifact in manifest['artifacts']:
        if artifact['status'] == 'not_requested':
            assert artifact['required'] is False and artifact['name'] is None
            continue
        data = (root / identity / artifact['name']).read_bytes()
        assert len(data) == artifact['size_bytes']
        assert hashlib.sha256(data).hexdigest() == artifact['sha256']
    assert manifest['synchronization']['encoded_pts_mapping'] == 'unavailable'


def test_capture_integrity_missing_retry_finalize_and_exports(capture_context):
    client, root, first, _ = capture_context
    capture = create_capture(client, first)
    identity = capture['id']
    batch_url = f'/api/captures/{identity}/landmark-batches'
    batch = frame_batch()
    assert client.post(batch_url, json=batch).json()['stored'] is True
    assert client.post(batch_url, json=batch).json()['stored'] is False
    altered = frame_batch(); altered['frames'][1]['timestamp_ms'] = 56
    assert client.post(batch_url, json=altered).status_code == 409
    assert put_chunk(client, identity, 1, b'second').json()['stored'] is True
    assert put_chunk(client, identity, 1, b'second').json()['stored'] is False
    assert put_chunk(client, identity, 1, b'different').status_code == 409
    assert put_chunk(client, identity, 0, b'first', digest='0' * 64).status_code == 422
    assert put_chunk(client, identity, 0, b'first', content_type='video/webm').status_code == 422
    assert finalize(client, identity).status_code == 409
    assert client.get(f'/api/captures/{identity}').json()['status'] == 'incomplete'
    assert (root / identity / 'staging' / 'chunks' / '1.chunk').read_bytes() == b'second'
    assert client.get(f'/api/captures/{identity}/artifacts/video').status_code == 404
    assert put_chunk(client, identity, 0, b'first').status_code == 200
    completed = finalize(client, identity)
    assert completed.status_code == 200, completed.text
    metadata = completed.json(); summary = metadata['artifact_summary']
    assert metadata['status'] == 'complete'
    assert (summary['frame_count'], summary['inferred_count'], summary['landmark_count']) == (3, 2, 3)
    assert (summary['valid_count'], summary['invalid_count']) == (2, 1)
    video = client.get(f'/api/captures/{identity}/artifacts/video')
    assert video.content == b'firstsecond'
    assert summary['video_sha256'] == hashlib.sha256(video.content).hexdigest()
    frames_response = client.get(f'/api/captures/{identity}/artifacts/frames')
    landmarks_response = client.get(f'/api/captures/{identity}/artifacts/landmarks')
    for name, response in [('frames', frames_response), ('landmarks', landmarks_response)]:
        assert response.status_code == 200
        assert hashlib.sha256(response.content).hexdigest() == summary[f'{name}_sha256']
    frames = pq.read_table(pa.BufferReader(frames_response.content)).to_pylist()
    points = pq.read_table(pa.BufferReader(landmarks_response.content)).to_pylist()
    assert [row['frame_id'] for row in frames] == [0, 1, 2]
    assert [row['video_media_time_ms'] for row in frames] == [25, 55, 90]
    assert frames[0]['inference_performed'] is False and frames[0]['pose_detected'] is None
    assert frames[1]['inference_performed'] is True and frames[1]['pose_detected'] is False
    assert all(row['capture_id'] == identity and row['patient_id'] == first[0] for row in points)
    assert [(row['coordinate_space'], row['representation'], row['x']) for row in points] == [
        ('normalized_image', 'raw', .1), ('normalized_image', 'display', .15), ('world', 'raw', 1.5)]
    assert points[-1]['is_valid'] is False and points[-1]['invalid_reason'] == 'test_invalid'
    rows = list(csv.DictReader(io.StringIO(client.get(f'/api/sessions/{first[1]}/video-manifest').text)))
    assert len(rows) == 1 and rows[0]['capture_id'] == identity and rows[0]['video_sha256'] == summary['video_sha256']
    assert rows[0]['video_url'] == f'/api/captures/{identity}/artifacts/video'
    assert rows[0]['frames_url'] == f'/api/captures/{identity}/artifacts/frames'
    assert rows[0]['landmarks_url'] == f'/api/captures/{identity}/artifacts/landmarks'
    assert rows[0]['started_at_utc'] and rows[0]['ended_at_utc']
    assert (rows[0]['width'], rows[0]['height']) == ('1920', '1080')
    assert json.loads(rows[0]['model_config_json']) == {'pose': 'test'}
    assert put_chunk(client, identity, 2, b'late').status_code == 409
    assert finalize(client, identity).status_code == 200
    assert finalize(client, identity, chunks=3).status_code == 409
    changed = {'expected_batches': 1, 'expected_video_chunks': 2,
               'ended_at_utc': '2026-01-01T00:00:02Z', 'duration_ms': 2000}
    assert client.post(f'/api/captures/{identity}/finalize', json=changed).status_code == 409


def test_tampered_chunk_and_abort_preserve_staging(capture_context):
    client, root, first, _ = capture_context
    identity = create_capture(client, first)['id']
    assert client.post(f'/api/captures/{identity}/landmark-batches', json=frame_batch()).status_code == 200
    assert put_chunk(client, identity, 0, b'original').status_code == 200
    path = root / identity / 'staging' / 'chunks' / '0.chunk'
    path.write_bytes(b'corrupted')
    assert finalize(client, identity, chunks=1).status_code == 409
    status = client.get(f'/api/captures/{identity}').json()
    assert status['status'] == 'incomplete'
    assert status['artifact_summary']['frames_status'] == 'complete'
    assert status['artifact_summary']['landmarks_status'] == 'complete'
    assert status['artifact_summary']['video_status'] == 'failed'
    assert status['artifact_summary']['frame_count'] == 3
    assert status['artifact_summary']['landmark_count'] == 3
    assert path.read_bytes() == b'corrupted'
    assert client.post(f'/api/captures/{identity}/abort', json={'reason': 'test'}).json()['status'] == 'aborted'
    assert put_chunk(client, identity, 1, b'later').status_code == 409
    assert path.read_bytes() == b'corrupted'


def test_private_download_and_traversal_rejected(capture_context):
    client, _, first, _ = capture_context
    identity = create_capture(client, first)['id']
    assert client.get(f'/api/captures/{identity}/artifacts/frames').status_code == 404
    assert client.get('/api/captures/not-a-uuid/artifacts/video').status_code == 422
    assert client.get(f'/api/captures/{identity}/artifacts/%2e%2e%2fvideo').status_code in (404, 422)
    with TestClient(app, client=('203.0.113.12', 1234)) as remote:
        assert remote.get(f'/api/captures/{identity}').status_code == 403


def test_recorder_start_records_actual_clock_and_mime_idempotently(capture_context):
    client, _, first, _ = capture_context
    payload = {**create_payload(first), 'source_type': 'webcam', 'video_mime_type': 'video/webm;codecs=vp8'}
    result = client.post('/api/captures', json=payload)
    assert result.status_code == 201
    identity = result.json()['id']
    path = f'/api/captures/{identity}/recorder-start'
    start = {'start_performance_ms': 130.25, 'started_at_utc': '2026-01-01T00:00:00.250Z', 'mime_type': 'video/webm;codecs=vp8'}
    assert finalize(client, identity).status_code == 409
    assert 'Recorder start metadata' in client.get(f'/api/captures/{identity}').json()['error_message']
    assert client.post(path, json={**start, 'started_at_utc': '2025-12-31T23:59:59Z'}).status_code == 422
    assert client.post(path, json={**start, 'start_performance_ms': 120}).status_code == 422
    assert client.post(path, json={**start, 'mime_type': 'video/mp4'}).status_code == 422
    response = client.post(path, json=start)
    assert response.status_code == 200, response.text
    stored = response.json()
    assert stored['video_mime_type'] == start['mime_type']
    assert stored['model_config_info']['recorder_start']['start_performance_ms'] == 130.25
    assert stored['model_config_info']['recorder_start']['started_at_utc'] == start['started_at_utc']
    assert stored['model_config_info']['recorder_start']['mime_type'] == start['mime_type']
    assert stored['model_config_info']['pose'] == 'test'
    assert client.post(path, json=start).status_code == 200
    assert client.post(path, json={**start, 'start_performance_ms': 130.5}).status_code == 409
    replay = create_capture(client, first)
    assert client.post(f"/api/captures/{replay['id']}/recorder-start", json=start).status_code == 409
    forged = {**payload, 'model_config': {'recorder_start': start}}
    assert client.post('/api/captures', json=forged).status_code == 422


def test_expired_lease_reconciles_without_touching_live_or_legacy_captures(capture_context):
    client, _, first, _ = capture_context
    expired = create_capture(client, first)['id']
    live = create_capture(client, first)['id']
    legacy = create_capture(client, first)['id']
    db = next(app.dependency_overrides[get_db]())
    db.execute(text("UPDATE capture_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = :id"), {'id': expired})
    db.execute(text('UPDATE capture_runs SET lease_expires_at = NULL WHERE id = :id'), {'id': legacy})
    db.flush()
    assert client.post(f'/api/captures/{live}/heartbeat').status_code == 200
    # Another instance can run reconciliation without affecting unexpired leases.
    assert captures.reconcile_expired(db) == 1
    db.commit()
    assert client.get(f'/api/captures/{expired}').json()['status'] == 'incomplete'
    assert client.get(f'/api/captures/{live}').json()['status'] == 'recording'
    assert client.get(f'/api/captures/{legacy}').json()['status'] == 'recording'
    assert client.post(f'/api/captures/{expired}/heartbeat').status_code == 409
    assert client.post(f'/api/captures/{expired}/abort').status_code == 200


def test_heartbeat_rejects_expired_lease_even_before_reconciliation(capture_context):
    client, _, first, _ = capture_context
    capture_id = create_capture(client, first)['id']
    db = next(app.dependency_overrides[get_db]())
    db.execute(text("UPDATE capture_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = :id"), {'id': capture_id})
    db.flush()
    assert client.post(f'/api/captures/{capture_id}/heartbeat').status_code == 409
    assert client.get(f'/api/captures/{capture_id}').json()['status'] == 'incomplete'


def test_expired_capture_recovery_requires_complete_staging_and_is_idempotent(capture_context):
    client, root, first, _ = capture_context
    identity = create_capture(client, first)['id']
    batch = frame_batch()
    assert client.post(f'/api/captures/{identity}/landmark-batches', json=batch).status_code == 200
    assert put_chunk(client, identity, 0, b'first').status_code == 200
    assert put_chunk(client, identity, 1, b'second').status_code == 200
    payload = {'expected_batches': 1, 'expected_video_chunks': 2,
               'ended_at_utc': '2026-01-01T00:00:01Z', 'duration_ms': 1000}
    path = f'/api/captures/{identity}/recover-finalize'
    # A live capture cannot be seized by recovery.
    assert client.post(path, json=payload).status_code == 409
    db = next(app.dependency_overrides[get_db]())
    db.execute(text("UPDATE capture_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = :id"), {'id': identity})
    db.flush()
    assert put_chunk(client, identity, 2, b'late').status_code == 409
    # An incorrect count must not clear expiry protection or remove staging.
    assert client.post(path, json={**payload, 'expected_video_chunks': 3}).status_code == 409
    assert client.get(f'/api/captures/{identity}').json()['status'] == 'incomplete'
    assert client.post(f'/api/captures/{identity}/landmark-batches', json=batch).status_code == 409
    assert (root / identity / 'staging' / 'chunks' / '0.chunk').read_bytes() == b'first'
    result = client.post(path, json=payload)
    assert result.status_code == 200, result.text
    assert result.json()['status'] == 'complete'
    assert client.get(f'/api/captures/{identity}/artifacts/video').content == b'firstsecond'
    assert client.post(path, json=payload).status_code == 200
    assert client.post(path, json={**payload, 'duration_ms': 1001}).status_code == 409
    assert put_chunk(client, identity, 2, b'late').status_code == 409


def test_recovery_never_accepts_aborted_or_other_incomplete_capture(capture_context):
    client, _, first, _ = capture_context
    identity = create_capture(client, first)['id']
    assert finalize(client, identity).status_code == 409
    payload = {'expected_batches': 1, 'expected_video_chunks': 2,
               'ended_at_utc': '2026-01-01T00:00:01Z', 'duration_ms': 1000}
    path = f'/api/captures/{identity}/recover-finalize'
    assert client.post(path, json=payload).status_code == 409
    assert client.post(f'/api/captures/{identity}/abort').status_code == 200
    assert client.post(path, json=payload).status_code == 409


def test_finalize_detects_staged_batch_tampering(capture_context):
    client, root, first, _ = capture_context
    identity = create_capture(client, first)['id']
    assert client.post(f'/api/captures/{identity}/landmark-batches', json=frame_batch()).status_code == 200
    assert put_chunk(client, identity, 0, b'video').status_code == 200
    path = root / identity / 'staging' / 'batches' / '0.json'
    staged = json.loads(path.read_text(encoding='utf-8'))
    staged['frames'][1]['timestamp_ms'] = 56
    path.write_text(json.dumps(staged), encoding='utf-8')
    assert finalize(client, identity, chunks=1).status_code == 409
    assert client.get(f'/api/captures/{identity}').json()['status'] == 'incomplete'
    assert json.loads(path.read_text(encoding='utf-8'))['frames'][1]['timestamp_ms'] == 56


def test_recovery_checks_expiry_without_prior_reconciliation(capture_context):
    client, root, first, _ = capture_context
    identity = create_capture(client, first)['id']
    assert client.post(f'/api/captures/{identity}/landmark-batches', json=frame_batch()).status_code == 200
    assert put_chunk(client, identity, 0, b'video').status_code == 200
    db = next(app.dependency_overrides[get_db]())
    db.execute(text("UPDATE capture_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = :id"), {'id': identity})
    db.flush()
    staged = root / identity / 'staging' / 'batches' / '0.json'
    staged.write_text('{}', encoding='utf-8')
    payload = {'expected_batches': 1, 'expected_video_chunks': 1,
               'ended_at_utc': '2026-01-01T00:00:01Z', 'duration_ms': 1000}
    assert client.post(f'/api/captures/{identity}/recover-finalize', json=payload).status_code == 409
    status = client.get(f'/api/captures/{identity}').json()
    assert status['status'] == 'incomplete' and status['error_message'] == captures.LEASE_EXPIRED
    assert client.post(f'/api/captures/{identity}/landmark-batches', json=frame_batch()).status_code == 409
    assert staged.read_text(encoding='utf-8') == '{}'


def phase2_capture(client, ids, game_key='glowing_flower'):
    db = next(app.dependency_overrides[get_db]())
    trial = db.get(models.Trial, ids[2])
    trial.exercise_code, trial.status = game_key, 'in_progress'
    db.flush()
    response = client.post('/api/captures', json={**create_payload(ids),
        'capture_mode': 'per_trial', 'capture_schema_version': 3})
    assert response.status_code == 201, response.text
    return response.json()['id']


def phase2_batch(identity, trial_id):
    def event(sequence, event_type, timestamp, payload):
        return dict(event_id=f'{identity}:event:{sequence}', event_schema_version=1,
            capture_id=identity, trial_id=trial_id, game_key='glowing_flower', sequence=sequence,
            event_type=event_type, timestamp_ms=timestamp, source_observation_id=None,
            source_timestamp_ms=None, frame_id=None, payload=payload)
    return {'batch_index': 0, 'events': [
        event(0, 'GAME_STARTED', 10, {'tracking_usable': True}),
        event(1, 'TARGET_SPAWNED', 10, {'target_id': 'target-1', 'target_sequence': 1,
            'target_x': .2, 'target_y': .4, 'target_radius': 20, 'radius_unit': 'px',
            'coordinate_space': 'display_normalized', 'width': 640, 'height': 480}),
        event(2, 'TARGET_TOUCHED', 90, {'target_id': 'target-1', 'cursor_x': .2, 'cursor_y': .4, 'score': 1}),
        event(3, 'GAME_COMPLETED', 100, {'score': 1, 'gameplay_elapsed_ms': 90}),
    ], 'samples': [dict(sample_id=f'{identity}:sample:{sequence}', sample_schema_version=1,
        capture_id=identity, trial_id=trial_id, game_key='glowing_flower', sequence=sequence,
        sample_type='flower_cursor', timestamp_ms=timestamp, source_timestamp_ms=timestamp,
        source_observation_id=observation, frame_id=None,
        payload={'target_id': 'target-1', 'x': x, 'y': .4, 'width': 640, 'height': 480,
            'coordinate_space': 'display_normalized', 'usable': True, 'freshness': 'fresh'})
        for sequence, timestamp, observation, x in [(0, 25, 10, .1), (1, 55, 11, .2)]]}


def post_game_batch(client, identity, batch):
    body = json.dumps(batch).encode()
    return client.post(f'/api/captures/{identity}/game-batches', content=body,
        headers={'Content-Type': 'application/json', 'X-Chunk-SHA256': hashlib.sha256(body).hexdigest()})


def stage_phase2_sources(client, identity):
    batch = frame_batch()
    for index, frame in enumerate(batch['frames']):
        frame['source_observation_id'] = 10 + index
        for model in ('pose', 'hand'):
            frame[f'{model}_inference_performed'] = frame['inference_performed']
            frame[f'{model}_inference_status'] = ('detected' if frame[f'{model}_detected'] else 'not_detected') if frame['inference_performed'] else 'not_run'
    assert client.post(f'/api/captures/{identity}/landmark-batches', json=batch).status_code == 200
    assert put_chunk(client, identity, 0, b'synthetic-fixture-video-container-not-validated').status_code == 200


def phase2_finalize_payload():
    return {'expected_batches': 1, 'expected_video_chunks': 1, 'expected_game_batches': 1,
        'game_data_complete': True, 'game_started_at_ms': 10, 'game_ended_at_ms': 100,
        'termination_reason': 'completed', 'ended_at_utc': '2026-01-01T00:00:01Z', 'duration_ms': 1000}


def test_phase2_upload_retry_finalize_readback_and_dataset_lookup(capture_context):
    client, root, first, _ = capture_context
    identity = phase2_capture(client, first)
    url = f'/api/captures/{identity}'
    game = phase2_batch(identity, first[2])
    assert client.post(f'{url}/game-batches', json=game).status_code == 422
    assert post_game_batch(client, identity, game).json()['stored'] is True
    assert post_game_batch(client, identity, game).json()['stored'] is False
    assert post_game_batch(client, identity, {**game, 'events': [{**game['events'][0], 'trial_id': first[2] + 1}]}).status_code == 422
    altered = {**game, 'events': [{**game['events'][0], 'payload': {'changed': True}}]}
    assert post_game_batch(client, identity, altered).status_code == 409
    stage_phase2_sources(client, identity)
    result = client.post(f'{url}/finalize', json=phase2_finalize_payload())
    assert result.status_code == 200, result.text
    assert result.json()['status'] == 'complete'
    summary = result.json()['artifact_summary']
    for kind, count in [('events', 4), ('interaction_samples', 2)]:
        artifact = root / identity / f'{kind}.parquet'
        assert pq.read_table(artifact).num_rows == count
        assert hashlib.sha256(artifact.read_bytes()).hexdigest() == summary[f'{kind}_sha256']
        assert client.get(f'{url}/artifacts/{kind}').content == artifact.read_bytes()
    metrics = json.loads((root / identity / 'game_metrics.json').read_text(encoding='utf-8'))
    assert metrics['trial']['completed_target_count']['value'] == 1
    assert metrics['source_artifact_checksums']['events.parquet'] == summary['events_sha256']
    assert summary['game_metrics_status'] == 'complete'
    assert len(list((root / identity / 'staging' / 'game_batches').glob('*.json'))) == 1
    assert client.get(f'/api/trials/{first[2]}/captures').json()[0]['id'] == identity
    assert client.get(f'/api/sessions/{first[1]}/captures').json()[0]['id'] == identity
    assert client.post(f'{url}/finalize', json=phase2_finalize_payload()).json()['status'] == 'complete'


def test_phase2_metrics_error_preserves_video_and_raw_artifacts(capture_context, monkeypatch):
    client, root, first, _ = capture_context
    identity = phase2_capture(client, first)
    stage_phase2_sources(client, identity)
    assert post_game_batch(client, identity, phase2_batch(identity, first[2])).status_code == 200
    def fail(*args):
        raise RuntimeError('deterministic metric failure')
    monkeypatch.setattr(captures, 'write_game_metrics', fail)
    url = f'/api/captures/{identity}'
    assert client.post(f'{url}/finalize', json=phase2_finalize_payload()).status_code == 409
    status = client.get(url).json()
    assert status['status'] == 'incomplete'
    assert status['artifact_summary']['game_metrics_status'] == 'failed'
    assert status['artifact_summary']['events_status'] == 'complete'
    for name in ('video.mp4', 'frames.parquet', 'landmarks.parquet', 'events.parquet', 'interaction_samples.parquet'):
        assert (root / identity / name).is_file()
    assert pq.read_table(root / identity / 'frames.parquet').num_rows == 3
    assert client.get(f'{url}/artifacts/events').status_code == 200


def test_phase2_missing_terminal_event_cannot_claim_complete(capture_context):
    client, root, first, _ = capture_context
    identity = phase2_capture(client, first)
    stage_phase2_sources(client, identity)
    batch = phase2_batch(identity, first[2])
    batch['events'] = batch['events'][:-1]
    assert post_game_batch(client, identity, batch).status_code == 200
    url = f'/api/captures/{identity}'
    assert client.post(f'{url}/finalize', json=phase2_finalize_payload()).status_code == 409
    status = client.get(url).json()
    assert status['status'] == 'incomplete' and status['artifact_summary']['events_status'] == 'failed'
    assert (root / identity / 'video.mp4').is_file()


def test_phase2_drawing_deleted_stroke_and_drag_history_remain_readable(capture_context):
    client, root, first, _ = capture_context
    identity = phase2_capture(client, first, 'free_drawing')
    stage_phase2_sources(client, identity)
    coordinates = {'coordinate_space': 'logical_canvas_px', 'width': 1000, 'height': 562.5,
        'drawing_mode': 'assisted', 'cursor_source': 'index', 'representation': 'game_processed', 'usable': True}
    event_data = [
        ('GAME_STARTED', 10, {'tracking_usable': True}),
        ('STROKE_STARTED', 25, {'stroke_id': 1, **coordinates}),
        ('STROKE_COMPLETED', 100, {'stroke_id': 1, 'reason': 'user_action', 'interrupted': False, 'point_count': 2}),
        ('STROKE_GRABBED', 110, {'drag_id': 1, 'stroke_id': 1, 'x': 10, 'y': 10, 'offset_x': 0, 'offset_y': 0, **coordinates}),
        ('STROKE_RELEASED', 160, {'drag_id': 1, 'stroke_id': 1, 'x': 20, 'y': 10, 'offset_x': 10, 'offset_y': 0, 'interrupted': False}),
        ('UNDO', 170, {'stroke_id': 1, 'operation': 'move', 'previous_offset': {'x': 0, 'y': 0}}),
        ('CLEAR_CANVAS', 180, {'stroke_ids': [1]}),
        ('GAME_COMPLETED', 200, {'reason': 'stopped'}),
    ]
    events = [dict(event_id=f'{identity}:event:{sequence}', event_schema_version=1,
        capture_id=identity, trial_id=first[2], game_key='free_drawing', sequence=sequence,
        event_type=kind, timestamp_ms=timestamp, payload=payload)
        for sequence, (kind, timestamp, payload) in enumerate(event_data)]
    sample_data = [
        ('drawing_stroke_point', 25, {'stroke_id': 1, 'x': 10, 'y': 10}),
        ('drawing_stroke_point', 55, {'stroke_id': 1, 'x': 20, 'y': 10}),
        ('drawing_drag_point', 120, {'stroke_id': 1, 'drag_id': 1, 'x': 15, 'y': 10, 'offset_x': 5, 'offset_y': 0}),
        ('drawing_drag_point', 150, {'stroke_id': 1, 'drag_id': 1, 'x': 20, 'y': 10, 'offset_x': 10, 'offset_y': 0}),
    ]
    samples = [dict(sample_id=f'{identity}:sample:{sequence}', sample_schema_version=1,
        capture_id=identity, trial_id=first[2], game_key='free_drawing', sequence=sequence,
        sample_type=kind, timestamp_ms=timestamp, payload={**coordinates, **payload})
        for sequence, (kind, timestamp, payload) in enumerate(sample_data)]
    assert post_game_batch(client, identity, {'batch_index': 0, 'events': events, 'samples': samples}).status_code == 200
    payload = {**phase2_finalize_payload(), 'game_ended_at_ms': 200}
    result = client.post(f'/api/captures/{identity}/finalize', json=payload)
    assert result.status_code == 200, result.text
    metrics = json.loads((root / identity / 'game_metrics.json').read_text(encoding='utf-8'))
    assert metrics['trial']['completed_stroke_count']['value'] == 1
    assert metrics['trial']['clear_count']['value'] == 1
    assert metrics['trial']['drag_completed_count']['value'] == 1
    table = pq.read_table(root / identity / 'interaction_samples.parquet').to_pylist()
    assert [json.loads(item['payload_json'])['x'] for item in table[:2]] == [10, 20]
    assert pq.read_table(root / identity / 'events.parquet').num_rows == len(events)
