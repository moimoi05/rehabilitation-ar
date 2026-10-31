"""A single transfer transaction is used by both administration and assessment results."""
import os

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from . import models, schemas
from .db import get_db
from .workflow_common import audit, commit, now, require, row_dict
from .workflow_schemas import TransferCreate

router = APIRouter(prefix='/api', tags=['patients'])


def allow_transfer_without_baseline():
    return os.getenv('ALLOW_TRANSFER_WITHOUT_BASELINE', 'false').lower() == 'true'


@router.get('/workflow-config')
def workflow_config():
    return {'allow_transfer_without_baseline': allow_transfer_without_baseline()}


def transfer_patient(db, patient_id, data):
    """Lock patient first; atomically retain baseline reference, transfer and audit."""
    person = db.scalar(select(models.Patient).where(models.Patient.id == patient_id).with_for_update().execution_options(populate_existing=True))
    if person is None:
        raise HTTPException(404, 'Không tìm thấy bệnh nhân.')
    if person.patient_type == data.to_type:
        raise HTTPException(409, 'Bệnh nhân đã thuộc nhóm này; không tạo chuyển nhóm trùng.')
    baseline = None
    if data.baseline_assessment_session_id is not None:
        baseline = db.scalar(select(models.Session).where(models.Session.id ==
            data.baseline_assessment_session_id).with_for_update().execution_options(populate_existing=True))
        if baseline is None or baseline.patient_id != person.id or baseline.session_type != 'assessment' or baseline.status != 'completed':
            raise HTTPException(422, 'Đánh giá đầu vào phải là lần đánh giá đã hoàn thành của đúng bệnh nhân.')
    if data.to_type == 'inpatient' and baseline is None:
        if not allow_transfer_without_baseline() or not data.allow_without_baseline or not data.reason:
            raise HTTPException(422, 'Cần đánh giá đầu vào đã hoàn thành; ngoại lệ cần được cấu hình và nhập lý do.')
    if data.to_type == 'outpatient' and not data.reason:
        raise HTTPException(422, 'Cần lý do chuyển về nhóm đến khám.')
    active_training = db.scalar(select(models.Session.id).where(models.Session.patient_id == person.id,
        models.Session.session_type == 'training', models.Session.status.in_(('draft', 'in_progress')),
        models.Session.managed_workflow.is_(True)).limit(1))
    if data.to_type == 'outpatient' and active_training is not None:
        raise HTTPException(409, 'Cần kết thúc hoặc hủy buổi tập còn dang dở trước khi chuyển nhóm.')
    try:
        admitted = data.admitted_at or now() if data.to_type == 'inpatient' else None
        transfer = models.PatientTransfer(patient_id=person.id, from_type=person.patient_type,
            to_type=data.to_type, baseline_assessment_session_id=baseline.id if baseline else None,
            admitted_at=admitted, reason=data.reason)
        person.patient_type = data.to_type
        person.admitted_at = admitted
        person.legacy_review_required = False
        db.add(transfer)
        db.flush()
        audit(db, person, 'transfer', {'transfer_id': transfer.id, 'to_type': data.to_type,
            'baseline_assessment_session_id': baseline.id if baseline else None})
        commit(db)
        db.refresh(transfer)
        return {'patient': schemas.PatientOut.model_validate(person), 'transfer': row_dict(transfer)}
    except SQLAlchemyError:
        db.rollback()
        raise


@router.post('/patients/{patient_id}/transfer')
def transfer(patient_id: int, data: TransferCreate, db: Session = Depends(get_db)):
    return transfer_patient(db, patient_id, data)


@router.get('/patients/{patient_id}/transfers')
def transfers(patient_id: int, db: Session = Depends(get_db)):
    require(db, models.Patient, patient_id)
    return [row_dict(item) for item in db.scalars(select(models.PatientTransfer).where(
        models.PatientTransfer.patient_id == patient_id).order_by(models.PatientTransfer.id.desc())).all()]
