"""Exercise catalog and explicit clinician prescriptions; no AI recommendations."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .db import get_db
from .workflow_common import audit, available_exercises, commit, require, row_dict
from .workflow_schemas import PrescriptionCreate, PrescriptionUpdate

router = APIRouter(prefix='/api', tags=['exercises', 'prescriptions'])


def prescription_response(db, entity):
    return {**row_dict(entity), 'exercise': row_dict(require(db, models.ExerciseCatalog, entity.exercise_id))}


@router.get('/exercises')
def exercises(mode: Literal['assessment', 'training'] | None = None,
        patient_id: int | None = Query(default=None, gt=0), db: Session = Depends(get_db)):
    if patient_id is not None:
        require(db, models.Patient, patient_id)
    return [row_dict(item) for item in available_exercises(db, mode, patient_id)]


@router.get('/exercises/{exercise_id}')
def exercise(exercise_id: int, db: Session = Depends(get_db)):
    return row_dict(require(db, models.ExerciseCatalog, exercise_id))


@router.get('/patients/{patient_id}/prescriptions')
def prescriptions(patient_id: int, db: Session = Depends(get_db)):
    require(db, models.Patient, patient_id)
    return [prescription_response(db, item) for item in db.scalars(select(models.ExercisePrescription).where(
        models.ExercisePrescription.patient_id == patient_id).order_by(models.ExercisePrescription.id.desc())).all()]


@router.post('/patients/{patient_id}/prescriptions', status_code=201)
def create_prescription(patient_id: int, data: PrescriptionCreate, db: Session = Depends(get_db)):
    person = db.scalar(select(models.Patient).where(models.Patient.id == patient_id).with_for_update().execution_options(populate_existing=True))
    if person is None:
        raise HTTPException(404, 'Không tìm thấy bệnh nhân.')
    if person.patient_type != 'inpatient':
        raise HTTPException(409, 'Chỉ định luyện tập cần bệnh nhân thuộc nhóm điều trị.')
    exercise = require(db, models.ExerciseCatalog, data.exercise_id)
    if not exercise.active or exercise.usage_mode not in ('training', 'both'):
        raise HTTPException(422, 'Bài tập không hoạt động hoặc không dùng cho luyện tập.')
    entity = models.ExercisePrescription(patient_id=patient_id, active=True, **data.model_dump())
    db.add(entity)
    db.flush()
    audit(db, entity, 'create')
    commit(db)
    return prescription_response(db, entity)


@router.patch('/prescriptions/{prescription_id}')
def update_prescription(prescription_id: int, data: PrescriptionUpdate, db: Session = Depends(get_db)):
    entity = db.scalar(select(models.ExercisePrescription).where(models.ExercisePrescription.id == prescription_id).with_for_update().execution_options(populate_existing=True))
    if entity is None:
        raise HTTPException(404, 'Không tìm thấy chỉ định.')
    changes = data.model_dump(exclude_unset=True)
    if any(key in changes and changes[key] is None for key in ('active', 'clinician_name')):
        raise HTTPException(422, 'Trường bắt buộc không được để trống.')
    combined = {key: getattr(entity, key) for key in ('exercise_id', 'clinician_name', 'notes', 'starts_on', 'ends_on')}
    try:
        PrescriptionCreate(**{**combined, **{k: v for k, v in changes.items() if k != 'active'}})
    except ValueError:
        raise HTTPException(422, 'Thông tin chỉ định không hợp lệ.') from None
    for key, value in changes.items():
        setattr(entity, key, value)
    audit(db, entity, 'update')
    commit(db)
    return prescription_response(db, entity)
