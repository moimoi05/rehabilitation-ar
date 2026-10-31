"""Assessment and training orchestrate the existing sessions/calibrations/trials."""
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import models, schemas
from .db import get_db
from .workflow_common import (audit, authorize_exercise, available_exercises, commit,
    complete_session, ensure_session_ready, locked_session, next_trial_number, now,
    require, selected_exercises, start_session)
from .workflow_schemas import AssessmentUpdate, DomainSessionCreate, TrialCreate, TrialOut

router = APIRouter(prefix='/api', tags=['assessments', 'training'])


def create_domain_session(db, data, kind):
    person = db.scalar(select(models.Patient).where(models.Patient.id == data.patient_id).with_for_update().execution_options(populate_existing=True))
    if person is None:
        raise HTTPException(404, 'Không tìm thấy bệnh nhân.')
    expected = 'outpatient' if kind == 'assessment' else 'inpatient'
    if person.patient_type != expected:
        raise HTTPException(409, 'Chỉ đánh giá bệnh nhân đến khám và luyện tập bệnh nhân điều trị. Kiểm tra hồ sơ trong Quản trị.')
    if kind == 'training':
        unfinished = db.scalar(select(models.Session.id).where(models.Session.patient_id == person.id,
            models.Session.session_type == kind, models.Session.managed_workflow.is_(True),
            models.Session.status.in_(('draft', 'in_progress'))).limit(1))
        if unfinished is not None:
            raise HTTPException(409, 'Có buổi tập còn dang dở. Hủy buổi cũ trước khi bắt đầu buổi mới.')
    entity = models.Session(patient_id=person.id, affected_side=person.affected_side,
        session_type=kind, status='draft', notes=data.notes, managed_workflow=True,
        setup_confirmed=False, setup_revision=0, started_at=now() if kind == 'training' else None)
    db.add(entity)
    db.flush()
    audit(db, entity, 'create')
    commit(db)
    return entity


@router.post('/assessments', response_model=schemas.SessionOut, status_code=201)
def create_assessment(data: DomainSessionCreate, db: Session = Depends(get_db)):
    return create_domain_session(db, data, 'assessment')


@router.post('/training-sessions', response_model=schemas.SessionOut, status_code=201)
def create_training(data: DomainSessionCreate, db: Session = Depends(get_db)):
    return create_domain_session(db, data, 'training')


def list_sessions(db, kind, patient_id):
    query = select(models.Session).where(models.Session.session_type == kind)
    if patient_id is not None:
        query = query.where(models.Session.patient_id == patient_id)
    return db.scalars(query.order_by(models.Session.created_at.desc(), models.Session.id.desc())).all()


@router.get('/assessments', response_model=list[schemas.SessionOut])
def assessments(patient_id: int | None = Query(default=None, gt=0), db: Session = Depends(get_db)):
    return list_sessions(db, 'assessment', patient_id)


@router.get('/training-sessions', response_model=list[schemas.SessionOut])
def training_sessions(patient_id: int | None = Query(default=None, gt=0), db: Session = Depends(get_db)):
    return list_sessions(db, 'training', patient_id)


@router.get('/assessments/{session_id}', response_model=schemas.SessionOut)
def assessment(session_id: int, db: Session = Depends(get_db)):
    entity = require(db, models.Session, session_id)
    if entity.session_type != 'assessment':
        raise HTTPException(404, 'Không tìm thấy lần đánh giá.')
    return entity


@router.get('/training-sessions/{session_id}', response_model=schemas.SessionOut)
def training_session(session_id: int, db: Session = Depends(get_db)):
    entity = require(db, models.Session, session_id)
    if entity.session_type != 'training':
        raise HTTPException(404, 'Không tìm thấy buổi tập.')
    return entity


@router.get('/assessments/{session_id}/detail')
def assessment_detail(session_id: int, db: Session = Depends(get_db)):
    from .workflow_reports import build_report
    return build_report(db, assessment(session_id, db))


@router.get('/training-sessions/{session_id}/detail')
def training_detail(session_id: int, db: Session = Depends(get_db)):
    from .workflow_reports import build_report
    return build_report(db, training_session(session_id, db))


@router.patch('/assessments/{session_id}', response_model=schemas.SessionOut)
def update_assessment(session_id: int, data: AssessmentUpdate, db: Session = Depends(get_db)):
    entity = locked_session(db, session_id, 'assessment')
    if entity.status in ('completed', 'cancelled'):
        raise HTTPException(409, 'Lần đánh giá đã kết thúc; dữ liệu được bảo toàn.')
    if 'selected_exercise_ids' in data.model_fields_set:
        if data.selected_exercise_ids is None:
            raise HTTPException(422, 'Danh sách bài không được là null.')
        allowed = {item.id for item in available_exercises(db, 'assessment')}
        if not set(data.selected_exercise_ids).issubset(allowed):
            raise HTTPException(422, 'Có bài không hoạt động hoặc không dùng cho đánh giá.')
        used = set(db.scalars(select(models.Trial.exercise_id).where(models.Trial.session_id == entity.id,
            models.Trial.exercise_id.is_not(None))).all())
        if not used.issubset(set(data.selected_exercise_ids)):
            raise HTTPException(409, 'Không bỏ bài đã có lượt thực hiện khỏi lần đánh giá.')
        db.execute(delete(models.SessionExercise).where(models.SessionExercise.session_id == entity.id))
        for exercise_id in data.selected_exercise_ids:
            db.add(models.SessionExercise(session_id=entity.id, exercise_id=exercise_id))
    if 'notes' in data.model_fields_set:
        entity.notes = data.notes
    if 'fma_ue_score' in data.model_fields_set and data.fma_ue_score is not None:
        clinical = models.ClinicalAssessment(patient_id=entity.patient_id, session_id=entity.id,
            fma_ue_score=data.fma_ue_score, clinician_name=data.clinician_name.strip(),
            clinician_confirmed=True, confirmed_at=now())
        db.add(clinical)
        db.flush()
        audit(db, clinical, 'confirm', {'source': 'clinician'})
    audit(db, entity, 'update')
    commit(db)
    return entity


@router.post('/assessments/{session_id}/start', response_model=schemas.SessionOut)
def start_assessment(session_id: int, db: Session = Depends(get_db)):
    entity = start_session(db, locked_session(db, session_id, 'assessment'))
    commit(db)
    return entity


@router.post('/training-sessions/{session_id}/start', response_model=schemas.SessionOut)
def start_training(session_id: int, db: Session = Depends(get_db)):
    entity = start_session(db, locked_session(db, session_id, 'training'))
    commit(db)
    return entity


@router.post('/assessments/{session_id}/complete', response_model=schemas.SessionOut)
def complete_assessment(session_id: int, db: Session = Depends(get_db)):
    entity = complete_session(db, locked_session(db, session_id, 'assessment'))
    commit(db)
    return entity


@router.post('/training-sessions/{session_id}/complete', response_model=schemas.SessionOut)
def complete_training(session_id: int, db: Session = Depends(get_db)):
    entity = complete_session(db, locked_session(db, session_id, 'training'))
    commit(db)
    return entity


def cancel_pending_trials(db, session_id):
    for trial in db.scalars(select(models.Trial).where(models.Trial.session_id == session_id,
            models.Trial.status == 'in_progress')).all():
        trial.status = 'cancelled'
        trial.ended_at = now()
        audit(db, trial, 'cancel')


@router.post('/sessions/{session_id}/setup/invalidate', response_model=schemas.SessionOut)
def invalidate_setup(session_id: int, db: Session = Depends(get_db)):
    entity = locked_session(db, session_id)
    if entity.status in ('completed', 'cancelled'):
        return entity
    entity.setup_confirmed = False
    entity.setup_revision += 1
    cancel_pending_trials(db, entity.id)
    audit(db, entity, 'invalidate_setup')
    commit(db)
    return entity


@router.post('/trials', response_model=TrialOut, status_code=201)
def create_trial(data: TrialCreate, response: Response, db: Session = Depends(get_db)):
    session = locked_session(db, data.session_id)
    if data.client_round_id is not None:
        prior = db.scalar(select(models.Trial).where(models.Trial.client_round_id == str(data.client_round_id)))
        if prior is not None:
            if prior.session_id != session.id or prior.exercise_id != data.exercise_id:
                raise HTTPException(409, 'Mã lượt đã được dùng cho bài khác.')
            response.status_code = 200
            return prior
    if not session.managed_workflow:
        raise HTTPException(409, 'Chức năng lượt mới chỉ dùng trong quy trình đánh giá hoặc luyện tập.')
    if session.status != 'in_progress':
        raise HTTPException(409, 'Cần bắt đầu đánh giá hoặc buổi tập trước khi tạo lượt.')
    ensure_session_ready(db, session)
    exercise = authorize_exercise(db, session, data.exercise_id)
    pending = db.scalar(select(models.Trial.id).where(models.Trial.session_id == session.id,
        models.Trial.status == 'in_progress').limit(1))
    if pending is not None:
        raise HTTPException(409, 'Còn lượt chưa lưu. Lưu hoặc hủy lượt hiện tại trước khi bắt đầu lượt mới.')
    entity = models.Trial(session_id=session.id, exercise_id=exercise.id,
        exercise_code=exercise.code, trial_number=next_trial_number(db, session.id),
        client_round_id=str(data.client_round_id) if data.client_round_id else None,
        started_at=now(), status='in_progress')
    db.add(entity)
    db.flush()
    audit(db, entity, 'start')
    commit(db)
    return entity


@router.get('/trials', response_model=list[TrialOut])
def trials(session_id: int = Query(gt=0), db: Session = Depends(get_db)):
    require(db, models.Session, session_id)
    return db.scalars(select(models.Trial).where(models.Trial.session_id == session_id)
        .order_by(models.Trial.trial_number.nulls_last(), models.Trial.id)).all()


@router.post('/trials/{trial_id}/cancel', response_model=TrialOut)
def cancel_trial(trial_id: int, db: Session = Depends(get_db)):
    initial = require(db, models.Trial, trial_id)
    session = locked_session(db, initial.session_id)
    if session.status in ('completed', 'cancelled'):
        raise HTTPException(409, 'Buổi đã kết thúc.')
    entity = db.scalar(select(models.Trial).where(models.Trial.id == trial_id).execution_options(populate_existing=True))
    if entity.status == 'in_progress':
        entity.status, entity.ended_at = 'cancelled', now()
        audit(db, entity, 'cancel')
        commit(db)
    return entity
