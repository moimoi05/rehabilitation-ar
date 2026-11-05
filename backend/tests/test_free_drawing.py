"""Focused drawing result contract and clinical round persistence checks."""
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select

from app import models, schemas
from app.db import get_db
from app.main import app
from app.workflow_common import authorize_exercise
from test_api import client


def drawing_payload(**changes):
    return {'session_id': 1, 'round_id': str(uuid4()), 'game_key': 'free_drawing',
        'source': 'camera', 'affected_side': 'left', 'duration_seconds': 30.,
        'completed_strokes': 4, 'active_drawing_seconds': 12., **changes}


def test_drawing_result_has_activity_fields_without_flower_score():
    result = schemas.ExerciseResultCreate(**drawing_payload())
    assert result.completed_strokes == 4
    assert result.active_drawing_seconds == 12.
    assert 'score' not in result.model_dump(exclude_none=True)
    assert 'target_count' not in result.model_dump(exclude_none=True)


def test_drawing_duration_is_not_limited_to_ten_minutes():
    result = schemas.ExerciseResultCreate(**drawing_payload(duration_seconds=3600, active_drawing_seconds=1200))
    assert result.duration_seconds == 3600
    assert result.active_drawing_seconds == 1200


def test_flower_duration_remains_limited_to_ten_minutes():
    payload = {key: value for key, value in drawing_payload().items()
        if key not in ('completed_strokes', 'active_drawing_seconds')}
    with pytest.raises(ValidationError):
        schemas.ExerciseResultCreate(**{**payload, 'game_key': 'glowing_flower',
            'score': 1, 'target_count': 1, 'duration_seconds': 601})


@pytest.mark.parametrize('changes', [
    {'completed_strokes': -1}, {'completed_strokes': True}, {'completed_strokes': 1.5},
    {'duration_seconds': 0}, {'duration_seconds': float('inf')}, {'duration_seconds': float('nan')},
    {'active_drawing_seconds': 31}, {'active_drawing_seconds': float('nan')},
    {'score': 0}, {'target_count': 0}, {'source': 'demo'},
])
def test_drawing_rejects_invalid_or_fabricated_activity(changes):
    with pytest.raises(ValidationError):
        schemas.ExerciseResultCreate(**drawing_payload(**changes))


def test_flower_contract_still_requires_its_original_score_fields():
    payload = {key: value for key, value in drawing_payload().items()
        if key not in ('completed_strokes', 'active_drawing_seconds')}
    flower = {**payload, 'game_key': 'glowing_flower', 'score': 2, 'target_count': 3}
    assert schemas.ExerciseResultCreate(**flower).score == 2
    for invalid in ({'score': 4}, {'completed_strokes': 1}, {'score': None}):
        with pytest.raises(ValidationError):
            schemas.ExerciseResultCreate(**{**flower, **invalid})


def prepare_drawing_trial(client):
    db = next(app.dependency_overrides[get_db]())
    game = db.scalar(select(models.ExerciseCatalog).where(models.ExerciseCatalog.code == 'free_drawing'))
    assert game is not None, 'Apply the Free Drawing catalog migration to the test database'
    person = models.Patient(research_code='DRAW-' + uuid4().hex[:12], affected_side='left',
        dominant_hand='right', patient_type='inpatient')
    db.add(person); db.flush()
    session = models.Session(patient_id=person.id, affected_side='left', session_type='training',
        status='in_progress', managed_workflow=True, setup_confirmed=True)
    db.add(session); db.flush()
    db.add(models.Calibration(session_id=session.id, affected_side='left', confirmed=True,
        camera_device_id='test-camera', width=640, height=480, mirrored=True,
        ghost_visible=True, opacity=.45, x=.5, y=.5, scale=1))
    db.add(models.ExercisePrescription(patient_id=person.id, exercise_id=game.id,
        active=True, clinician_name='Test clinician'))
    db.commit()
    round_id = str(uuid4())
    trial = client.post('/api/trials', json={'session_id': session.id, 'exercise_id': game.id,
        'client_round_id': round_id})
    assert trial.status_code == 201, trial.text
    return db, session, game, drawing_payload(session_id=session.id,
        trial_id=trial.json()['id'], round_id=round_id)


def test_drawing_round_saves_atomically_retries_and_catalog_supports_both_workflows(client):
    db, session, game, payload = prepare_drawing_trial(client)
    assert game.usage_mode == 'both' and game.renderer == 'free_drawing' and not game.is_default
    assert game.id in [row['id'] for row in client.get('/api/exercises', params={'mode': 'assessment'}).json()]
    response = client.post('/api/exercise-results', json=payload)
    assert response.status_code == 201, response.text
    record = response.json()
    assert 'score' not in record and 'target_count' not in record
    assert record['completed_strokes'] == 4
    assert client.post('/api/exercise-results', json=payload).status_code == 200
    assert client.post('/api/exercise-results', json={**payload, 'completed_strokes': 5}).status_code == 409
    saved_trial = db.get(models.Trial, payload['trial_id'])
    db.refresh(saved_trial)
    assert saved_trial.status == 'completed' and saved_trial.ended_at is not None
    assert client.get('/api/exercise-results', params={'session_id': session.id}).json() == [record]
    report = client.get(f'/api/training-sessions/{session.id}/detail').json()
    assert report['results'][0]['completed_strokes'] == 4
    assert 'score' not in report['results'][0]
    session.session_type = 'assessment'
    with pytest.raises(HTTPException):
        authorize_exercise(db, session, game.id)


def test_drawing_cannot_be_saved_as_flower_or_complete_a_failed_save(client, monkeypatch):
    db, session, game, payload = prepare_drawing_trial(client)
    flower = {key: value for key, value in payload.items()
        if key not in ('completed_strokes', 'active_drawing_seconds')}
    response = client.post('/api/exercise-results', json={**flower,
        'game_key': 'glowing_flower', 'score': 1, 'target_count': 2})
    assert response.status_code == 422
    trial = db.get(models.Trial, payload['trial_id'])
    db.refresh(trial)
    assert trial.status == 'in_progress' and trial.ended_at is None

    from sqlalchemy.exc import SQLAlchemyError
    original_commit = db.commit
    def fail_commit():
        raise SQLAlchemyError('Simulated test transaction failure')
    monkeypatch.setattr(db, 'commit', fail_commit)
    assert client.post('/api/exercise-results', json=payload).status_code == 503
    monkeypatch.setattr(db, 'commit', original_commit)
    db.refresh(trial)
    assert trial.status == 'in_progress' and trial.ended_at is None
    assert not db.scalar(select(models.ExerciseResult).where(models.ExerciseResult.round_id == payload['round_id']))
    assert client.post('/api/exercise-results', json=payload).status_code == 201


def test_drawing_assessment_uses_same_result_contract_without_clinical_score(client):
    from test_workflows import patient, assessment, questionnaire, setup
    person = patient(client)
    visit = assessment(client, person)
    questionnaire(client, visit)
    game = next(item for item in client.get('/api/exercises', params={'mode': 'assessment'}).json()
                if item['code'] == 'free_drawing')
    selected = client.patch(f"/api/assessments/{visit['id']}", json={'selected_exercise_ids': [game['id']]})
    assert selected.status_code == 200, selected.text
    setup(client, visit)
    assert client.post(f"/api/assessments/{visit['id']}/start").status_code == 200
    round_id = str(uuid4())
    trial = client.post('/api/trials', json=dict(session_id=visit['id'], exercise_id=game['id'], client_round_id=round_id))
    assert trial.status_code == 201, trial.text
    result = client.post('/api/exercise-results', json=drawing_payload(session_id=visit['id'], trial_id=trial.json()['id'], round_id=round_id))
    assert result.status_code == 201, result.text
    assert result.json()['completed_strokes'] == 4
    assert 'score' not in result.json()
