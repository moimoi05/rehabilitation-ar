"""Immutable questionnaire versions and assessment-local snapshots/answers."""
import math
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import models
from .db import get_db
from .workflow_common import audit, commit, locked_session, require
from .workflow_schemas import AnswersCreate, SubmissionCreate, TemplateCreate

router = APIRouter(prefix='/api', tags=['questionnaires'])


def template_response(db, template):
    questions = db.scalars(select(models.QuestionnaireQuestion).where(
        models.QuestionnaireQuestion.template_id == template.id).order_by(
        models.QuestionnaireQuestion.display_order, models.QuestionnaireQuestion.id)).all()
    return {'id': template.id, 'code': template.code, 'name': template.name,
        'version': template.version, 'active': template.active, 'questions': [{
            name: getattr(question, name) for name in ('id', 'key', 'label', 'group',
            'question_type', 'required', 'display_order', 'options')} for question in questions]}


def submission_response(db, submission):
    answers = db.scalars(select(models.QuestionnaireAnswer).where(
        models.QuestionnaireAnswer.submission_id == submission.id).order_by(models.QuestionnaireAnswer.id)).all()
    return {'id': submission.id, 'session_id': submission.session_id,
        'template_id': submission.template_id, 'template_snapshot': submission.template_snapshot,
        'completed': submission.completed, 'created_at': submission.created_at,
        'answers': [{'question_key': item.question_key, 'value': item.value} for item in answers]}


@router.get('/questionnaires')
def templates(include_inactive: bool = False, db: Session = Depends(get_db)):
    query = select(models.QuestionnaireTemplate)
    if not include_inactive:
        query = query.where(models.QuestionnaireTemplate.active.is_(True))
    return [template_response(db, item) for item in db.scalars(query.order_by(
        models.QuestionnaireTemplate.version.desc(), models.QuestionnaireTemplate.id.desc())).all()]


@router.get('/questionnaires/{template_id}')
def template(template_id: int, db: Session = Depends(get_db)):
    return template_response(db, require(db, models.QuestionnaireTemplate, template_id))


@router.post('/questionnaires', status_code=201)
def create_template(data: TemplateCreate, db: Session = Depends(get_db)):
    # A stable code lock also covers a code with no rows yet. Locking only old
    # versions can miss a version inserted while a concurrent SELECT waits.
    db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(data.code, 0))))
    prior = db.scalars(select(models.QuestionnaireTemplate).where(
        models.QuestionnaireTemplate.code == data.code).with_for_update()).all()
    if any(item.version >= data.version for item in prior):
        raise HTTPException(409, 'Phải tạo phiên bản mới lớn hơn phiên bản đã có; không sửa nội dung cũ.')
    entity = models.QuestionnaireTemplate(**data.model_dump(exclude={'questions'}))
    db.add(entity)
    db.flush()
    for item in prior:
        if data.active:
            item.active = False
    for question in data.questions:
        db.add(models.QuestionnaireQuestion(template_id=entity.id, **question.model_dump()))
    audit(db, entity, 'create')
    commit(db)
    return template_response(db, entity)


@router.post('/questionnaire-submissions', status_code=201)
def create_submission(data: SubmissionCreate, db: Session = Depends(get_db)):
    session = locked_session(db, data.session_id, 'assessment')
    existing = db.scalar(select(models.QuestionnaireSubmission).where(
        models.QuestionnaireSubmission.session_id == session.id,
        models.QuestionnaireSubmission.template_id == data.template_id))
    if existing is not None:
        return submission_response(db, existing)
    if session.status in ('completed', 'cancelled'):
        raise HTTPException(409, 'Lần đánh giá đã kết thúc.')
    template = require(db, models.QuestionnaireTemplate, data.template_id)
    if not template.active:
        raise HTTPException(409, 'Bộ câu hỏi này không còn dùng cho lần đánh giá mới.')
    entity = models.QuestionnaireSubmission(session_id=session.id, template_id=template.id,
        template_snapshot=template_response(db, template), completed=False)
    db.add(entity)
    db.flush()
    audit(db, entity, 'create')
    commit(db)
    return submission_response(db, entity)


@router.get('/questionnaire-submissions/{submission_id}')
def submission(submission_id: int, db: Session = Depends(get_db)):
    return submission_response(db, require(db, models.QuestionnaireSubmission, submission_id))


def validate_answer(question, value):
    kind = question['question_type']
    if value is None or value == '':
        if question['required']:
            raise HTTPException(422, f"Cần trả lời: {question['label']}")
        return
    valid = False
    if kind == 'text':
        valid = isinstance(value, str) and len(value) <= 10000 and (not question['required'] or bool(value.strip()))
    elif kind == 'number':
        valid = type(value) in (int, float) and abs(value) <= 1e12 and math.isfinite(value)
    elif kind == 'boolean':
        valid = type(value) is bool
    elif kind == 'date':
        try:
            valid = type(value) is str and date.fromisoformat(value).isoformat() == value
        except ValueError:
            valid = False
    elif kind == 'single_choice':
        valid = type(value) is str and value in question['options']
    elif kind == 'multiple_choice':
        valid = (isinstance(value, list) and len(value) <= 100 and
            all(type(item) is str and item in question['options'] for item in value) and
            len(value) == len(set(value)) and (not question['required'] or bool(value)))
    if not valid:
        raise HTTPException(422, f"Câu trả lời không đúng định dạng: {question['label']}")


@router.post('/questionnaire-submissions/{submission_id}/answers')
def save_answers(submission_id: int, data: AnswersCreate, db: Session = Depends(get_db)):
    initial = require(db, models.QuestionnaireSubmission, submission_id)
    session = locked_session(db, initial.session_id, 'assessment')
    entity = db.scalar(select(models.QuestionnaireSubmission).where(
        models.QuestionnaireSubmission.id == submission_id).with_for_update().execution_options(populate_existing=True))
    if entity.completed or session.status in ('completed', 'cancelled'):
        raise HTTPException(409, 'Câu trả lời đã hoàn tất được bảo toàn; tạo lần đánh giá mới để đánh giá lại.')
    questions = {item['key']: item for item in entity.template_snapshot['questions']}
    existing = {answer.question_key: answer for answer in db.scalars(select(models.QuestionnaireAnswer).where(
        models.QuestionnaireAnswer.submission_id == entity.id)).all()}
    incoming = {answer.question_key: answer.value for answer in data.answers}
    if any(key not in questions for key in incoming):
        raise HTTPException(422, 'Mã câu hỏi không thuộc bản câu hỏi của lần đánh giá này.')
    for key, value in incoming.items():
        validate_answer(questions[key], value)
    combined = {**{key: answer.value for key, answer in existing.items()}, **incoming}
    if data.complete:
        for key, question in questions.items():
            if question['required']:
                if key not in combined:
                    raise HTTPException(422, f"Cần trả lời: {question['label']}")
                validate_answer(question, combined[key])
    for key, value in incoming.items():
        if key in existing:
            existing[key].value = value
        else:
            db.add(models.QuestionnaireAnswer(submission_id=entity.id, question_key=key, value=value))
    entity.completed = data.complete
    audit(db, entity, 'complete' if data.complete else 'update')
    commit(db)
    return submission_response(db, entity)
