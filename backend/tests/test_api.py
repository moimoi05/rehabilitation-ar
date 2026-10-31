"""Integration tests run against an explicitly supplied PostgreSQL URL in rolled-back transactions."""
import os
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.db import get_db
from app.main import app

@pytest.fixture
def client():
    url = os.getenv('TEST_DATABASE_URL')
    if not url:
        pytest.skip('TEST_DATABASE_URL is required for PostgreSQL integration tests')
    if not url.startswith('postgresql+psycopg://'):
        pytest.fail('Tests require PostgreSQL')
    engine = create_engine(url)
    connection = engine.connect()
    transaction = connection.begin()
    db = Session(bind=connection, join_transaction_mode='create_savepoint', expire_on_commit=False)
    def override_db():
        yield db
    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    db.close()
    transaction.rollback()
    connection.close()
    engine.dispose()


def test_patient_session_calibration_lifecycle(client):
    code = 'TEST-' + uuid4().hex[:12]
    patient = client.post('/api/patients', json={'research_code': code, 'affected_side': 'left', 'dominant_hand': 'right'})
    assert patient.status_code == 201
    patient_id = patient.json()['id']
    assert client.post('/api/patients', json={'research_code': code, 'affected_side': 'left', 'dominant_hand': 'right'}).status_code == 409
    assert client.patch(f'/api/patients/{patient_id}', json={'affected_side': 'right'}).json()['affected_side'] == 'right'
    assert client.get(f'/api/patients/{patient_id}').json()['research_code'] == code
    assert client.post('/api/sessions', json={'patient_id': 999999999, 'affected_side': 'left', 'session_type': 'assessment'}).status_code == 404
    session = client.post('/api/sessions', json={'patient_id': patient_id, 'affected_side': 'left', 'session_type': 'assessment'})
    assert session.status_code == 201
    session_id = session.json()['id']
    started = client.patch(f'/api/sessions/{session_id}', json={'status': 'in_progress'})
    assert started.json()['started_at'] is not None
    first = client.post('/api/calibrations', json={'session_id': session_id, 'affected_side': 'left', 'x': .4, 'y': .6, 'scale': 1.2, 'confirmed': True})
    assert first.status_code == 201
    assert client.get(f"/api/calibrations/{first.json()['id']}").json()['confirmed'] is True
    assert client.get('/api/calibrations', params={'session_id': session_id}).json()[0]['x'] == .4
    finished = client.patch(f'/api/sessions/{session_id}', json={'status': 'completed'})
    assert finished.json()['ended_at'] is not None
    assert client.patch(f'/api/sessions/{session_id}', json={'status': 'in_progress'}).status_code == 409
    assert client.get('/api/sessions', params={'patient_id': patient_id}).json()[0]['id'] == session_id


def test_calibration_image_anchor_round_trip_and_legacy_record(client):
    code = 'TEST-' + uuid4().hex[:12]
    patient = client.post('/api/patients', json={'research_code': code, 'affected_side': 'left', 'dominant_hand': 'right'}).json()
    session = client.post('/api/sessions', json={'patient_id': patient['id'], 'affected_side': 'left', 'session_type': 'assessment'}).json()
    base = {'session_id': session['id'], 'affected_side': 'left', 'x': .4, 'y': .6, 'scale': 1.2}
    legacy = client.post('/api/calibrations', json=base)
    assert legacy.status_code == 201
    assert legacy.json()['image_anchor'] is None
    anchor = {'version': 1, 'x': .25, 'y': .75, 'scale': 1.5}
    response = client.post('/api/calibrations', json={**base, 'image_anchor': anchor})
    assert response.status_code == 201
    assert response.json()['image_anchor'] == anchor
    assert response.json()['x'] == .4
    assert client.get(f"/api/calibrations/{response.json()['id']}").json()['image_anchor'] == anchor
    assert client.get('/api/calibrations', params={'session_id': session['id']}).json()[0]['image_anchor'] == anchor
    assert client.post('/api/calibrations', json={**base, 'image_anchor': {**anchor, 'version': 2}}).status_code == 422


def test_reject_invalid_calibration_and_cancel_marks_end(client):
    code = 'TEST-' + uuid4().hex[:12]
    patient_id = client.post('/api/patients', json={'research_code': code, 'affected_side': 'left', 'dominant_hand': 'right'}).json()['id']
    session_id = client.post('/api/sessions', json={'patient_id': patient_id, 'affected_side': 'left', 'session_type': 'assessment'}).json()['id']
    assert client.post('/api/calibrations', json={'session_id': session_id, 'affected_side': 'left', 'x': 3}).status_code == 422
    cancelled = client.patch(f'/api/sessions/{session_id}', json={'status': 'cancelled'})
    assert cancelled.json()['ended_at'] is not None
    assert client.patch(f'/api/sessions/{session_id}', json={'status': 'in_progress'}).status_code == 409


def test_client_cannot_forge_session_times_or_terminal_status(client):
    code = 'TEST-' + uuid4().hex[:12]
    patient_id = client.post('/api/patients', json={'research_code': code, 'affected_side': 'left', 'dominant_hand': 'right'}).json()['id']
    base = {'patient_id': patient_id, 'affected_side': 'left', 'session_type': 'assessment'}
    assert client.post('/api/sessions', json={**base, 'status': 'completed'}).status_code == 422
    assert client.post('/api/sessions', json={**base, 'ended_at': '2030-01-01T00:00:00Z'}).status_code == 422
    session_id = client.post('/api/sessions', json=base).json()['id']
    assert client.patch(f'/api/sessions/{session_id}', json={'started_at': '2030-01-01T00:00:00Z'}).status_code == 422
    assert client.patch(f'/api/sessions/{session_id}', json={'status': 'in_progress'}).status_code == 200
    assert client.patch(f'/api/sessions/{session_id}', json={'status': 'completed'}).status_code == 200
    assert client.patch(f'/api/sessions/{session_id}', json={'ended_at': None}).status_code == 422


def test_flower_result_round_trip_and_session_isolation(client):
    code = 'TEST-' + uuid4().hex[:12]
    patient_id = client.post('/api/patients', json={'research_code': code, 'affected_side': 'left', 'dominant_hand': 'right'}).json()['id']
    # Exercise the legacy research Flower schema and UUID behavior. Clinical
    # training has separate inpatient/setup/multi-trial regression coverage.
    session_data = {'patient_id': patient_id, 'affected_side': 'left', 'session_type': 'assessment'}
    first = client.post('/api/sessions', json=session_data).json()['id']
    second = client.post('/api/sessions', json=session_data).json()['id']
    payload = {'session_id': first, 'round_id': str(uuid4()), 'game_key': 'glowing_flower', 'source': 'camera', 'affected_side': 'left', 'duration_seconds': 30.0, 'score': 4, 'target_count': 5}
    assert client.post('/api/exercise-results', json=payload).status_code == 409
    assert client.patch(f'/api/sessions/{first}', json={'status': 'in_progress'}).status_code == 200
    response = client.post('/api/exercise-results', json=payload)
    assert response.status_code == 201
    record = response.json()
    assert all(record[key] == value for key, value in payload.items())
    assert record['id'] > 0 and record['trial_id'] > 0 and record['created_at']
    assert client.get('/api/exercise-results', params={'session_id': first}).json() == [record]
    assert client.get('/api/exercise-results', params={'session_id': second}).json() == []
    assert client.get('/api/exercise-results', params={'session_id': 999999999}).status_code == 404
    duplicate = client.post('/api/exercise-results', json=payload)
    assert duplicate.status_code == 200 and duplicate.json() == record
    assert client.post('/api/exercise-results', json={**payload, 'score': 3}).status_code == 409
    assert client.patch(f'/api/sessions/{first}', json={'status': 'completed'}).status_code == 200
    assert client.post('/api/exercise-results', json=payload).status_code == 200
    assert client.post('/api/exercise-results', json={**payload, 'round_id': str(uuid4())}).status_code == 409


def test_flower_result_rejects_demo_and_invalid_values(client):
    payload = {'session_id': 1, 'round_id': str(uuid4()), 'game_key': 'glowing_flower', 'source': 'camera', 'affected_side': 'right', 'duration_seconds': 30.5, 'score': 2, 'target_count': 3}
    for invalid in ({'source': 'demo'}, {'score': 4}, {'score': -1}, {'duration_seconds': 0}, {'duration_seconds': 601}, {'game_key': 'other'}, {'target_count': -1}, {'round_id': 'invalid'}):
        assert client.post('/api/exercise-results', json={**payload, **invalid}).status_code == 422
