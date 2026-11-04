"""Database-derived dashboards and reports retain historical assessment/baseline data."""
import json
import math
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import models, schemas
from .db import get_db
from .questionnaires import submission_response
from .workflow_catalog import prescription_response
from .workflow_common import available_exercises, hospital_timezone, require, row_dict, selected_exercises
from .workflow_schemas import TrialOut

router = APIRouter(prefix='/api', tags=['reports'])


def safe_payload(result):
    try:
        value = json.loads(result.result_json)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def legacy_result(result, trial):
    payload = safe_payload(result)
    allowed = set(schemas.ExerciseResultCreate.model_fields)
    values = {key: value for key, value in payload.items() if key in allowed and key != 'trial_id'}
    try:
        return schemas.ExerciseResultOut(**values, id=result.id, trial_id=trial.id,
            created_at=result.created_at, exercise_id=trial.exercise_id,
            exercise_code=trial.exercise_code).model_dump(mode='json', exclude_none=True)
    except ValidationError:
        # Unknown legacy JSON is exposed verbatim on the trial, never fabricated.
        return None


def build_report(db, session, exercise_id=None):
    person = require(db, models.Patient, session.patient_id)
    query = select(models.Trial).where(models.Trial.session_id == session.id)
    if exercise_id is not None:
        query = query.where(models.Trial.exercise_id == exercise_id)
    trials = db.scalars(query.order_by(models.Trial.trial_number.nulls_last(), models.Trial.id)).all()
    trial_rows, result_rows, duration = [], [], 0.
    for trial in trials:
        results = db.scalars(select(models.ExerciseResult).where(models.ExerciseResult.trial_id == trial.id)
            .order_by(models.ExerciseResult.id)).all()
        trial_rows.append({**TrialOut.model_validate(trial).model_dump(mode='json'),
            'results': [row_dict(result) for result in results]})
        for result in results:
            parsed = legacy_result(result, trial)
            if parsed is not None:
                result_rows.append(parsed)
            elapsed = safe_payload(result).get('duration_seconds')
            if type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed > 0:
                duration += elapsed
    submissions = db.scalars(select(models.QuestionnaireSubmission).where(
        models.QuestionnaireSubmission.session_id == session.id).order_by(models.QuestionnaireSubmission.id)).all()
    clinical = db.scalars(select(models.ClinicalAssessment).where(
        models.ClinicalAssessment.session_id == session.id).order_by(models.ClinicalAssessment.id.desc())).all()
    baseline = db.scalar(select(models.PatientTransfer.id).where(
        models.PatientTransfer.baseline_assessment_session_id == session.id).limit(1))
    captures = db.scalars(select(models.CaptureRun).where(models.CaptureRun.trial_id.in_(
        [trial.id for trial in trials])).order_by(models.CaptureRun.created_at)).all()
    return {'session': schemas.SessionOut.model_validate(session),
        'patient': schemas.PatientOut.model_validate(person),
        'questionnaires': [submission_response(db, item) for item in submissions],
        'clinical_assessments': [row_dict(item) for item in clinical],
        'trials': trial_rows, 'results': result_rows, 'duration_seconds': duration,
        'trial_count': len(trials), 'is_baseline': baseline is not None,
        'captures': [{key: getattr(item, key) for key in ('id', 'trial_id', 'source_type', 'status',
            'record_video', 'record_landmarks', 'artifact_summary')} for item in captures],
        'selected_exercise_ids': selected_exercises(db, session.id)}


def report_list(db, kind, patient_id=None, research_code=None, from_date=None,
        to_date=None, exercise_id=None, session_id=None):
    if from_date and to_date and to_date < from_date:
        raise HTTPException(422, 'Khoảng thời gian không hợp lệ.')
    query = select(models.Session).join(models.Patient).where(models.Session.session_type == kind)
    if patient_id is not None:
        query = query.where(models.Session.patient_id == patient_id)
    if research_code:
        query = query.where(models.Patient.research_code.ilike('%' + research_code.replace('%', '\\%').replace('_', '\\_') + '%', escape='\\'))
    moment = func.coalesce(models.Session.started_at, models.Session.created_at)
    if from_date:
        query = query.where(moment >= datetime.combine(from_date, time.min, hospital_timezone()).astimezone(timezone.utc))
    if to_date:
        query = query.where(moment <= datetime.combine(to_date, time.max, hospital_timezone()).astimezone(timezone.utc))
    if exercise_id is not None:
        query = query.where(models.Session.id.in_(select(models.Trial.session_id).where(models.Trial.exercise_id == exercise_id)))
    if session_id is not None:
        query = query.where(models.Session.id == session_id)
    return [build_report(db, item, exercise_id) for item in db.scalars(query.order_by(
        models.Session.created_at.desc(), models.Session.id.desc())).all()]


@router.get('/reports/assessments')
def assessment_reports(patient_id: int | None = Query(default=None, gt=0), research_code: str | None = Query(default=None, max_length=64),
        from_date: date | None = None, to_date: date | None = None, exercise_id: int | None = Query(default=None, gt=0),
        session_id: int | None = Query(default=None, gt=0), db: Session = Depends(get_db)):
    return report_list(db, 'assessment', patient_id, research_code, from_date, to_date, exercise_id, session_id)


@router.get('/reports/training')
def training_reports(patient_id: int | None = Query(default=None, gt=0), research_code: str | None = Query(default=None, max_length=64),
        from_date: date | None = None, to_date: date | None = None, exercise_id: int | None = Query(default=None, gt=0),
        session_id: int | None = Query(default=None, gt=0), db: Session = Depends(get_db)):
    return report_list(db, 'training', patient_id, research_code, from_date, to_date, exercise_id, session_id)


@router.get('/reports/patients/{patient_id}')
def patient_report(patient_id: int, db: Session = Depends(get_db)):
    person = require(db, models.Patient, patient_id)
    transfers = db.scalars(select(models.PatientTransfer).where(models.PatientTransfer.patient_id == patient_id)
        .order_by(models.PatientTransfer.id.desc())).all()
    prescriptions = db.scalars(select(models.ExercisePrescription).where(models.ExercisePrescription.patient_id == patient_id)
        .order_by(models.ExercisePrescription.id.desc())).all()
    return {'patient': schemas.PatientOut.model_validate(person), 'transfers': [row_dict(item) for item in transfers],
        'assessments': report_list(db, 'assessment', patient_id), 'training': report_list(db, 'training', patient_id),
        'prescriptions': [prescription_response(db, item) for item in prescriptions],
        'available_exercises': [row_dict(item) for item in available_exercises(db, 'training', patient_id)]}


@router.get('/dashboard')
def dashboard(db: Session = Depends(get_db)):
    def count(model, condition):
        return db.scalar(select(func.count()).select_from(model).where(condition)) or 0
    recent = db.execute(select(models.Session, models.Patient).join(models.Patient)
        .order_by(models.Session.created_at.desc(), models.Session.id.desc()).limit(8)).all()
    return {'outpatients': count(models.Patient, models.Patient.patient_type == 'outpatient'),
        'inpatients': count(models.Patient, models.Patient.patient_type == 'inpatient'),
        'assessments': count(models.Session, models.Session.session_type == 'assessment'),
        'training_sessions': count(models.Session, models.Session.session_type == 'training'),
        'recent_activity': [{'session': schemas.SessionOut.model_validate(session),
            'patient': schemas.PatientOut.model_validate(person)} for session, person in recent]}


@router.get('/reports/patient-classification')
def classification_review(db: Session = Depends(get_db)):
    return [{'id': person.id, 'research_code': person.research_code, 'patient_type': person.patient_type,
        'created_at': person.created_at} for person in db.scalars(select(models.Patient).where(
            models.Patient.legacy_review_required.is_(True)).order_by(models.Patient.id)).all()]
