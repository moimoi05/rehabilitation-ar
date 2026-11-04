"""Shared invariants for domain APIs and compatibility endpoints."""
import json
import os
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from . import models


def now():
    return datetime.now(timezone.utc)


def hospital_timezone():
    try:
        return ZoneInfo(os.getenv('HOSPITAL_TIMEZONE', 'Asia/Bangkok'))
    except ZoneInfoNotFoundError as exc:
        raise RuntimeError('HOSPITAL_TIMEZONE không hợp lệ hoặc thiếu dữ liệu tzdata') from exc


def require(db, model, identity):
    entity = db.get(model, identity)
    if entity is None:
        raise HTTPException(404, 'Không tìm thấy dữ liệu.')
    return entity


def locked_session(db, identity, kind=None):
    session = db.scalar(select(models.Session).where(models.Session.id == identity)
        .with_for_update().execution_options(populate_existing=True))
    if session is None or (kind and session.session_type != kind):
        raise HTTPException(404, 'Không tìm thấy lần đánh giá hoặc buổi tập.')
    return session


def audit(db, entity, action, detail=None):
    db.add(models.AuditLog(entity_type=entity.__tablename__, entity_id=entity.id,
        action=action, detail=json.dumps(detail, ensure_ascii=False) if detail is not None else None))


def commit(db):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Dữ liệu trùng hoặc không hợp lệ; thay đổi chưa được lưu.') from None
    except SQLAlchemyError:
        db.rollback()
        raise


def selected_exercises(db, session_id):
    return list(db.scalars(select(models.SessionExercise.exercise_id).where(
        models.SessionExercise.session_id == session_id).order_by(models.SessionExercise.exercise_id)).all())


def available_exercises(db, mode, patient_id=None):
    query = select(models.ExerciseCatalog).where(models.ExerciseCatalog.active.is_(True))
    if mode:
        query = query.where(models.ExerciseCatalog.usage_mode.in_((mode, 'both')))
    return db.scalars(query.order_by(models.ExerciseCatalog.id)).all()


def ensure_setup(db, session):
    latest = db.scalar(select(models.Calibration).where(models.Calibration.session_id == session.id)
        .order_by(models.Calibration.id.desc()).limit(1))
    if not session.setup_confirmed or latest is None or not latest.confirmed or latest.affected_side != session.affected_side:
        raise HTTPException(409, 'Cần kiểm tra tư thế và lưu hiệu chuẩn camera hợp lệ trước khi thực hiện.')


def ensure_session_ready(db, session):
    if session.status not in ('draft', 'in_progress'):
        raise HTTPException(409, 'Lần đánh giá hoặc buổi tập đã kết thúc.')
    person = require(db, models.Patient, session.patient_id)
    expected = 'inpatient' if session.session_type == 'training' else 'outpatient'
    if person.patient_type != expected:
        raise HTTPException(409, 'Nhóm bệnh nhân không phù hợp với quy trình này.')
    ensure_setup(db, session)
    if session.session_type == 'assessment':
        completed = db.scalar(select(models.QuestionnaireSubmission.id).where(
            models.QuestionnaireSubmission.session_id == session.id,
            models.QuestionnaireSubmission.completed.is_(True)).limit(1))
        if completed is None:
            raise HTTPException(409, 'Cần hoàn tất câu hỏi lâm sàng trước khi đánh giá.')
        if not selected_exercises(db, session.id):
            raise HTTPException(409, 'Cần chọn ít nhất một bài đánh giá.')


def authorize_exercise(db, session, exercise_id):
    exercise = require(db, models.ExerciseCatalog, exercise_id)
    if exercise.renderer not in ('flower', 'free_drawing'):
        raise HTTPException(409, 'Bài tập chưa có giao diện thực hiện được hỗ trợ.')
    if exercise.renderer == 'free_drawing' and session.session_type != 'training':
        raise HTTPException(409, 'Vẽ tự do chỉ dùng trong luyện tập, không dùng để đánh giá.')
    allowed = {item.id for item in available_exercises(db, session.session_type,
        session.patient_id if session.session_type == 'training' else None)}
    if exercise_id not in allowed:
        raise HTTPException(409, 'Bài tập không hoạt động hoặc không dùng cho buổi này.')
    if session.session_type == 'assessment' and exercise_id not in selected_exercises(db, session.id):
        raise HTTPException(409, 'Bài tập chưa được chọn trong lần đánh giá này.')
    return exercise


def start_session(db, session):
    ensure_session_ready(db, session)
    if session.status == 'draft':
        session.status = 'in_progress'
        session.started_at = session.started_at or now()
        audit(db, session, 'start')
    return session


def complete_session(db, session):
    if session.status == 'completed':
        return session
    if session.status != 'in_progress':
        raise HTTPException(409, 'Chỉ hoàn tất khi đang thực hiện.')
    pending = db.scalar(select(models.Trial.id).where(models.Trial.session_id == session.id,
        models.Trial.status == 'in_progress').limit(1))
    if pending is not None:
        raise HTTPException(409, 'Còn lượt chưa hoàn thành. Lưu kết quả hoặc hủy lượt trước khi kết thúc.')
    capture = db.scalar(select(models.CaptureRun.id).where(models.CaptureRun.session_id == session.id,
        models.CaptureRun.status == 'recording').limit(1))
    if capture is not None:
        raise HTTPException(409, 'Cần kết thúc ghi dữ liệu nghiên cứu trước khi kết thúc buổi.')
    if session.session_type == 'assessment':
        ensure_session_ready(db, session)
        completed = set(db.scalars(select(models.Trial.exercise_id).join(models.ExerciseResult).where(
            models.Trial.session_id == session.id, models.Trial.status == 'completed')).all())
        if not set(selected_exercises(db, session.id)).issubset(completed):
            raise HTTPException(409, 'Cần có kết quả cho mỗi bài đã chọn trước khi hoàn tất đánh giá.')
    session.status = 'completed'
    session.ended_at = now()
    session.setup_confirmed = False
    audit(db, session, 'complete')
    return session


def next_trial_number(db, session_id):
    return (db.scalar(select(func.max(models.Trial.trial_number)).where(
        models.Trial.session_id == session_id)) or 0) + 1


def row_dict(entity):
    return {column.name: getattr(entity, column.name) for column in entity.__table__.columns}
