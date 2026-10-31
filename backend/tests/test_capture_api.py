"""Capture integration tests: explicit PostgreSQL, rolled-back DB, private temp files."""
import csv
import hashlib
import io
import json
import os
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
