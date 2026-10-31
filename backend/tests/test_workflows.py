"""Hospital workflows use the existing PostgreSQL graph without replacing history."""
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import models
from app.db import get_db
from app.main import app
from test_api import client  # shared real PostgreSQL rollback fixture


def test_workflow_configuration_is_explicit(monkeypatch):
    monkeypatch.delenv('ALLOW_TRANSFER_WITHOUT_BASELINE', raising=False)
    app.dependency_overrides[get_db] = lambda: None
    try:
        with TestClient(app) as http:
            response = http.get('/api/workflow-config')
            assert response.status_code == 200
            assert response.json() == {'allow_transfer_without_baseline': False}
    finally:
        app.dependency_overrides.clear()


def test_legacy_session_url_cannot_start_outpatient_training(client):
    person = patient(client)
    response = client.post('/api/sessions', json={'patient_id': person['id'],
        'affected_side': 'left', 'session_type': 'training'})
    assert response.status_code == 409
    visit = client.post('/api/sessions', json={'patient_id': person['id'],
        'affected_side': 'left', 'session_type': 'assessment'}).json()
    assert client.patch(f"/api/sessions/{visit['id']}", json={'session_type': 'training'}).status_code == 409
    assert client.get(f"/api/sessions/{visit['id']}").json()['session_type'] == 'assessment'
    baseline = complete_assessment(client, person)
    assert transfer(client, person, baseline).status_code == 200
    training = client.post('/api/sessions', json={'patient_id': person['id'],
        'affected_side': 'left', 'session_type': 'training'})
    assert training.status_code == 201
    assert training.json()['managed_workflow'] is True
    assert client.patch(f"/api/sessions/{training.json()['id']}", json={'status': 'in_progress'}).status_code == 409


def test_new_research_sessions_cannot_bypass_clinical_baseline_or_reporting(client):
    person = patient(client)
    before = client.get('/api/dashboard').json()['assessments']
    research = client.post('/api/sessions', json={'patient_id': person['id'],
        'affected_side': 'left', 'session_type': 'assessment'})
    assert research.status_code == 201
    visit = research.json()
    assert visit['research_only'] is True
    # Research camera/tracking tools keep their legacy lifecycle and result API.
    assert client.patch(f"/api/sessions/{visit['id']}", json={'status': 'in_progress'}).status_code == 200
    assert client.patch(f"/api/sessions/{visit['id']}", json={'status': 'completed'}).status_code == 200
    assert client.post(f"/api/patients/{person['id']}/transfer", json={
        'to_type': 'inpatient', 'baseline_assessment_session_id': visit['id']}).status_code == 422
    assert client.get(f"/api/patients/{person['id']}").json()['patient_type'] == 'outpatient'
    assert client.get('/api/assessments', params={'patient_id': person['id']}).json() == []
    assert client.get('/api/reports/assessments', params={'patient_id': person['id']}).json() == []
    assert client.post(f"/api/assessments/{visit['id']}/start").status_code == 409
    assert client.patch(f"/api/sessions/{visit['id']}", json={'research_only': False}).status_code == 422
    assert client.get('/api/dashboard').json()['assessments'] == before
    assert client.get('/api/sessions', params={'patient_id': person['id']}).json()[0]['id'] == visit['id']


def test_historical_completed_assessments_remain_eligible_as_baseline(client):
    person = patient(client)
    db = next(app.dependency_overrides[get_db]())
    historical = models.Session(patient_id=person['id'], affected_side='left',
        session_type='assessment', status='completed', managed_workflow=False,
        research_only=False)
    db.add(historical); db.commit()
    assert transfer(client, person, {'id': historical.id}).status_code == 200


def test_reports_link_existing_capture_metadata_to_the_correct_trial(client):
    person = patient(client)
    visit = complete_assessment(client, person)
    detail = client.get(f"/api/assessments/{visit['id']}/detail").json()
    trial_id = detail['trials'][0]['id']
    db = next(app.dependency_overrides[get_db]())
    capture_id = str(uuid4())
    db.add(models.CaptureRun(id=capture_id, patient_id=person['id'], session_id=visit['id'],
        trial_id=trial_id, source_type='webcam', status='complete', record_video=True,
        record_landmarks=False, consent_video=True, consent_landmarks=False,
        started_at_utc=datetime.now(timezone.utc), start_performance_ms=0,
        model_config_info={}, artifact_summary={'video_status': 'complete', 'video_file': 'video.webm'}))
    db.commit()
    saved = client.get(f"/api/assessments/{visit['id']}/detail").json()
    assert saved['captures'] == [{'id': capture_id, 'trial_id': trial_id, 'source_type': 'webcam',
        'status': 'complete', 'record_video': True, 'record_landmarks': False,
        'artifact_summary': {'video_status': 'complete', 'video_file': 'video.webm'}}]
    another = assessment(client, person)
    assert client.get(f"/api/assessments/{another['id']}/detail").json()['captures'] == []


def patient(client, **changes):
    payload = {'research_code': 'WF-' + uuid4().hex[:12], 'affected_side': 'left',
               'dominant_hand': 'right', 'full_name': 'Hồ sơ thử nghiệm'}
    response = client.post('/api/patients', json={**payload, **changes})
    assert response.status_code == 201, response.text
    return response.json()


def assessment(client, person):
    response = client.post('/api/assessments', json={'patient_id': person['id']})
    assert response.status_code == 201, response.text
    return response.json()


def questionnaire(client, session):
    template = client.get('/api/questionnaires').json()[0]
    submission = client.post('/api/questionnaire-submissions', json={
        'session_id': session['id'], 'template_id': template['id']}).json()
    values = {'text': 'Theo hồ sơ chuyên môn', 'number': 2, 'date': '2026-01-01',
              'boolean': False}
    answers = []
    for question in template['questions']:
        kind = question['question_type']
        value = question['options'][:1] if kind == 'multiple_choice' else (
            question['options'][0] if kind == 'single_choice' else values[kind])
        answers.append({'question_key': question['key'], 'value': value})
    response = client.post(f"/api/questionnaire-submissions/{submission['id']}/answers",
                           json={'answers': answers, 'complete': True})
    assert response.status_code == 200, response.text
    return response.json()


def setup(client, session):
    current = client.get(f"/api/sessions/{session['id']}").json()
    response = client.post('/api/calibrations', json={'session_id': session['id'],
        'affected_side': 'left', 'confirmed': True, 'ghost_visible': True,
        'camera_device_id': 'fake-camera', 'width': 640, 'height': 480,
        'setup_revision': current['setup_revision']})
    assert response.status_code == 201, response.text


def exercise(client, mode='assessment', patient_id=None):
    return client.get('/api/exercises', params={'mode': mode, **(
        {'patient_id': patient_id} if patient_id else {})}).json()[0]


def save_round(client, session, game):
    trial = client.post('/api/trials', json={'session_id': session['id'],
        'exercise_id': game['id']})
    assert trial.status_code == 201, trial.text
    payload = {'session_id': session['id'], 'trial_id': trial.json()['id'],
        'round_id': str(uuid4()), 'game_key': 'glowing_flower', 'source': 'camera',
        'affected_side': 'left', 'duration_seconds': 30., 'score': 2, 'target_count': 3}
    result = client.post('/api/exercise-results', json=payload)
    assert result.status_code == 201, result.text
    assert result.json()['trial_id'] == trial.json()['id']
    assert client.post('/api/exercise-results', json=payload).status_code == 200
    return result.json()


def complete_assessment(client, person):
    session = assessment(client, person)
    questionnaire(client, session)
    game = exercise(client)
    assert client.patch(f"/api/assessments/{session['id']}",
        json={'selected_exercise_ids': [game['id']]}).status_code == 200
    setup(client, session)
    started = client.post(f"/api/assessments/{session['id']}/start")
    assert started.status_code == 200, started.text
    save_round(client, session, game)
    done = client.post(f"/api/assessments/{session['id']}/complete")
    assert done.status_code == 200, done.text
    return done.json()


def transfer(client, person, baseline):
    return client.post(f"/api/patients/{person['id']}/transfer", json={
        'to_type': 'inpatient', 'baseline_assessment_session_id': baseline['id'],
        'reason': 'Chỉ định điều trị do nhân viên chuyên môn xác nhận'})


def test_patient_profile_search_groups_transfer_preserves_baseline(client):
    person = patient(client, date_of_birth='1960-02-03', sex='female', contact='test')
    assert person['patient_type'] == 'outpatient'
    assert client.patch(f"/api/patients/{person['id']}", json={'full_name': 'Tên cập nhật'}).json()['full_name'] == 'Tên cập nhật'
    assert client.post('/api/patients', json={'research_code': person['research_code'],
        'affected_side': 'left', 'dominant_hand': 'right'}).status_code == 409
    baseline = complete_assessment(client, person)
    result = transfer(client, person, baseline)
    assert result.status_code == 200, result.text
    assert result.json()['patient']['id'] == person['id']
    assert result.json()['patient']['patient_type'] == 'inpatient'
    assert result.json()['transfer']['baseline_assessment_session_id'] == baseline['id']
    assert transfer(client, person, baseline).status_code == 409
    assert len(client.get(f"/api/patients/{person['id']}/transfers").json()) == 1
    assert client.get('/api/patients', params={'patient_type': 'outpatient', 'search': person['research_code']}).json() == []
    inpatient = client.get('/api/patients', params={'patient_type': 'inpatient', 'search': person['research_code']}).json()
    assert [p['id'] for p in inpatient] == [person['id']]
    reports = client.get('/api/reports/assessments', params={'patient_id': person['id']}).json()
    assert reports[0]['is_baseline'] is True
    assert reports[0]['session']['id'] == baseline['id']
    assert reports[0]['trial_count'] == 1
    assert reports[0]['duration_seconds'] == 30
    assert reports[0]['questionnaires'][0]['completed'] is True


def test_transfer_validation_and_atomic_failure(client, monkeypatch):
    person = patient(client)
    other = patient(client)
    baseline = complete_assessment(client, other)
    assert transfer(client, person, baseline).status_code == 422
    assert client.get(f"/api/patients/{person['id']}").json()['patient_type'] == 'outpatient'
    assert client.get(f"/api/patients/{person['id']}/transfers").json() == []
    missing = client.post(f"/api/patients/{person['id']}/transfer", json={'to_type': 'inpatient'})
    assert missing.status_code == 422
    monkeypatch.setenv('ALLOW_TRANSFER_WITHOUT_BASELINE', 'true')
    assert client.post(f"/api/patients/{person['id']}/transfer", json={
        'to_type': 'inpatient', 'allow_without_baseline': True}).status_code == 422
    exception = client.post(f"/api/patients/{person['id']}/transfer", json={
        'to_type': 'inpatient', 'allow_without_baseline': True, 'reason': 'Ngoại lệ được cho phép'})
    assert exception.status_code == 200, exception.text
    assert exception.json()['transfer']['baseline_assessment_session_id'] is None


def test_new_assessment_each_visit_and_gates_camera_questionnaire_selection(client):
    person = patient(client)
    first, second = assessment(client, person), assessment(client, person)
    assert first['id'] != second['id']
    assert first['managed_workflow'] is True
    assert client.post(f"/api/assessments/{first['id']}/start").status_code == 409
    assert client.patch(f"/api/sessions/{first['id']}", json={'status': 'in_progress'}).status_code == 409
    assert client.post('/api/trials', json={'session_id': first['id'], 'exercise_id': exercise(client)['id']}).status_code == 409
    questionnaire(client, first)
    setup(client, first)
    assert client.post(f"/api/assessments/{first['id']}/start").status_code == 409
    selected = client.get('/api/exercises', params={'mode': 'assessment'}).json()
    assert len(selected) >= 2
    assert client.patch(f"/api/assessments/{first['id']}", json={
        'selected_exercise_ids': [g['id'] for g in selected]}).status_code == 200
    assert client.post(f"/api/assessments/{first['id']}/start").status_code == 200
    for game in selected:
        save_round(client, first, game)
    assert client.post(f"/api/assessments/{first['id']}/complete").status_code == 200
    assert client.get(f"/api/assessments/{first['id']}/detail").json()['trial_count'] == len(selected)


def test_questionnaire_types_required_snapshot_and_immutable_completion(client):
    person = patient(client)
    session = assessment(client, person)
    completed = questionnaire(client, session)
    assert completed['template_snapshot']['questions']
    assert client.post(f"/api/questionnaire-submissions/{completed['id']}/answers", json={
        'answers': [], 'complete': False}).status_code == 409
    second = assessment(client, person)
    template_id = completed['template_id']
    submission = client.post('/api/questionnaire-submissions', json={
        'session_id': second['id'], 'template_id': template_id}).json()
    assert client.post(f"/api/questionnaire-submissions/{submission['id']}/answers", json={
        'answers': [], 'complete': True}).status_code == 422
    assert client.post(f"/api/questionnaire-submissions/{submission['id']}/answers", json={
        'answers': [{'question_key': 'unknown', 'value': 'x'}], 'complete': False}).status_code == 422
    detail = client.get(f"/api/questionnaire-submissions/{completed['id']}").json()
    assert detail['template_snapshot'] == completed['template_snapshot']


def test_training_requires_inpatient_prescription_multi_trial_one_session(client):
    person = patient(client)
    assert client.post('/api/training-sessions', json={'patient_id': person['id']}).status_code == 409
    baseline = complete_assessment(client, person)
    assert transfer(client, person, baseline).status_code == 200
    games = client.get('/api/exercises', params={'mode': 'training', 'patient_id': person['id']}).json()
    assert len(games) == 1 and games[0]['is_default']
    all_games = client.get('/api/exercises', params={'mode': 'assessment'}).json()
    additional = next(g for g in all_games if not g['is_default'])
    prescription = client.post(f"/api/patients/{person['id']}/prescriptions", json={
        'exercise_id': additional['id'], 'clinician_name': 'Bác sĩ thử nghiệm'})
    assert prescription.status_code == 201, prescription.text
    current = client.post('/api/training-sessions', json={'patient_id': person['id']}).json()
    assert current['status'] == 'draft' and current['started_at']
    assert client.post(f"/api/training-sessions/{current['id']}/start").status_code == 409
    setup(client, current)
    assert client.post(f"/api/training-sessions/{current['id']}/start").status_code == 200
    one = save_round(client, current, games[0])
    two = save_round(client, current, additional)
    assert one['session_id'] == two['session_id'] == current['id']
    detail = client.get(f"/api/training-sessions/{current['id']}/detail").json()
    assert detail['trial_count'] == 2 and detail['duration_seconds'] == 60
    assert [t['trial_number'] for t in detail['trials']] == [1, 2]
    assert len(client.get('/api/training-sessions', params={'patient_id': person['id']}).json()) == 1
    assert client.post(f"/api/training-sessions/{current['id']}/complete").json()['status'] == 'completed'
    assert client.post('/api/trials', json={'session_id': current['id'], 'exercise_id': games[0]['id']}).status_code == 409
    reports = client.get('/api/reports/training', params={'patient_id': person['id'],
        'exercise_id': additional['id'], 'from_date': '2020-01-01', 'to_date': '2099-01-01'}).json()
    assert len(reports) == 1
    assert reports[0]['trial_count'] == 1
    assert reports[0]['trials'][0]['exercise_id'] == additional['id']


def test_calibration_invalidation_blocks_new_round_and_prescription_revocation(client):
    person = patient(client)
    baseline = complete_assessment(client, person)
    transfer(client, person, baseline)
    current = client.post('/api/training-sessions', json={'patient_id': person['id']}).json()
    setup(client, current)
    client.post(f"/api/training-sessions/{current['id']}/start")
    game = exercise(client, 'training', person['id'])
    save_round(client, current, game)
    assert client.post(f"/api/sessions/{current['id']}/setup/invalidate").status_code == 200
    assert client.post('/api/trials', json={'session_id': current['id'], 'exercise_id': game['id']}).status_code == 409
    assert client.get(f"/api/training-sessions/{current['id']}").json()['status'] == 'in_progress'
    setup(client, current)
    save_round(client, current, game)
    assert client.get(f"/api/training-sessions/{current['id']}/detail").json()['trial_count'] == 2


def test_fma_is_manual_confirmed_and_session_specific(client):
    person = patient(client)
    first, second = assessment(client, person), assessment(client, person)
    endpoint = f"/api/assessments/{first['id']}"
    assert client.patch(endpoint, json={'fma_ue_score': 34, 'clinician_confirmed': True}).status_code == 422
    assert client.patch(endpoint, json={'fma_ue_score': 67,
        'clinician_name': 'Người đánh giá', 'clinician_confirmed': True}).status_code == 422
    assert client.patch(endpoint, json={'fma_ue_score': 34,
        'clinician_name': 'Người đánh giá', 'clinician_confirmed': True}).status_code == 200
    assert client.get(endpoint + '/detail').json()['clinical_assessments'][0]['fma_ue_score'] == 34
    assert client.get(f"/api/assessments/{second['id']}/detail").json()['clinical_assessments'] == []


def test_dashboard_counts_database_and_report_date_validation(client):
    before = client.get('/api/dashboard').json()
    person = patient(client)
    assessment(client, person)
    after = client.get('/api/dashboard').json()
    assert after['outpatients'] == before['outpatients'] + 1
    assert after['assessments'] == before['assessments'] + 1
    assert client.get('/api/reports/training', params={
        'from_date': '2026-10-31', 'to_date': '2026-01-01'}).status_code == 422


def test_local_report_date_includes_sessions_after_local_midnight(client):
    person = patient(client)
    session = assessment(client, person)
    generator = app.dependency_overrides[get_db]()
    db = next(generator)
    entity = db.get(models.Session, session['id'])
    entity.started_at = datetime(2026, 10, 30, 18, 30, tzinfo=timezone.utc)
    db.commit()
    response = client.get('/api/reports/assessments', params={
        'patient_id': person['id'], 'from_date': '2026-10-31', 'to_date': '2026-10-31'})
    assert [report['session']['id'] for report in response.json()] == [session['id']]


def test_transfer_failure_rolls_back_patient_history_and_audit(client, monkeypatch):
    from app import workflow_patients
    from sqlalchemy.exc import SQLAlchemyError
    person = patient(client)
    baseline = complete_assessment(client, person)
    def broken_audit(*_args, **_kwargs):
        raise SQLAlchemyError('simulated audit persistence failure')
    monkeypatch.setattr(workflow_patients, 'audit', broken_audit)
    response = transfer(client, person, baseline)
    assert response.status_code == 503
    assert client.get(f"/api/patients/{person['id']}").json()['patient_type'] == 'outpatient'
    assert client.get(f"/api/patients/{person['id']}/transfers").json() == []
    assert client.get(f"/api/assessments/{baseline['id']}").json()['status'] == 'completed'


def test_stale_session_identity_does_not_revalidate_old_camera_revision(client):
    from sqlalchemy import update
    person = patient(client)
    session = assessment(client, person)
    setup(client, session)
    generator = app.dependency_overrides[get_db]()
    db = next(generator)
    stale = db.get(models.Session, session['id'])
    assert stale.setup_confirmed
    db.execute(update(models.Session).where(models.Session.id == stale.id).values(
        setup_revision=1, setup_confirmed=False).execution_options(synchronize_session=False))
    assert stale.setup_revision == 0
    response = client.post('/api/calibrations', json={'session_id': session['id'],
        'affected_side': 'left', 'confirmed': True, 'ghost_visible': True,
        'camera_device_id': 'fake-camera', 'width': 640, 'height': 480, 'setup_revision': 0})
    assert response.status_code == 409
    assert client.get(f"/api/sessions/{session['id']}").json()['setup_confirmed'] is False


def test_catalog_prescription_revoke_and_trial_start_idempotency(client):
    person = patient(client)
    baseline = complete_assessment(client, person)
    transfer(client, person, baseline)
    game = next(g for g in client.get('/api/exercises').json() if not g['is_default'])
    prescription = client.post(f"/api/patients/{person['id']}/prescriptions", json={
        'exercise_id': game['id'], 'clinician_name': 'Bác sĩ', 'starts_on': '2020-01-01', 'ends_on': '2099-01-01'}).json()
    session = client.post('/api/training-sessions', json={'patient_id': person['id']}).json()
    setup(client, session)
    client.post(f"/api/training-sessions/{session['id']}/start")
    payload = {'session_id': session['id'], 'exercise_id': game['id'], 'client_round_id': str(uuid4())}
    first = client.post('/api/trials', json=payload)
    second = client.post('/api/trials', json=payload)
    assert first.status_code == 201 and second.status_code == 200
    assert first.json()['id'] == second.json()['id']
    assert client.post(f"/api/training-sessions/{session['id']}/complete").status_code == 409
    assert client.post(f"/api/trials/{first.json()['id']}/cancel").json()['status'] == 'cancelled'
    assert client.patch(f"/api/prescriptions/{prescription['id']}", json={'ends_on': '2010-01-01'}).status_code == 422
    assert client.patch(f"/api/prescriptions/{prescription['id']}", json={'active': False}).json()['active'] is False
    assert client.post('/api/trials', json={**payload, 'client_round_id': str(uuid4())}).status_code == 409
    assert len(client.get(f"/api/patients/{person['id']}/prescriptions").json()) == 1
    assert client.get(f"/api/exercises/{game['id']}").json()['code'] == game['code']


def test_questionnaire_new_version_preserves_completed_snapshot(client):
    person = patient(client)
    session = assessment(client, person)
    old = questionnaire(client, session)
    template = client.get('/api/questionnaires').json()[0]
    payload = {'code': template['code'], 'name': 'Bộ câu hỏi phiên bản mới', 'version': template['version'] + 1,
        'questions': [{'key': 'changed', 'label': 'Nội dung thay đổi', 'question_type': 'text', 'display_order': 0, 'required': True}]}
    new = client.post('/api/questionnaires', json=payload)
    assert new.status_code == 201, new.text
    assert client.post('/api/questionnaires', json=payload).status_code == 409
    assert client.get(f"/api/questionnaire-submissions/{old['id']}").json()['template_snapshot'] == old['template_snapshot']
    assert client.get('/api/questionnaires').json()[0]['version'] == new.json()['version']
    assert len(client.get('/api/questionnaires', params={'include_inactive': True}).json()) >= 2


def test_completed_managed_session_rejects_new_research_capture(client, monkeypatch, tmp_path):
    monkeypatch.setenv('REHAB_DATA_DIR', str(tmp_path))
    person = patient(client)
    baseline = complete_assessment(client, person)
    payload = {'patient_id': person['id'], 'session_id': baseline['id'],
        'source_type': 'webcam', 'record_landmarks': True, 'record_video': False,
        'consent_landmarks': True, 'started_at_utc': '2026-10-31T00:00:00Z',
        'start_performance_ms': 100}
    response = client.post('/api/captures', json=payload)
    assert response.status_code == 409
    assert client.get(f"/api/sessions/{baseline['id']}/captures").json() == []
