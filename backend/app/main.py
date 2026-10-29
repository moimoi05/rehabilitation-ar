from datetime import datetime, timezone
import json
import os
from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import inspect, insert, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session as DBSession
from .db import get_db, get_engine
from . import models, schemas

app = FastAPI(title='Rehabilitation AR - development only', version='0.1.0')
origins = [value.strip() for value in os.getenv('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(',') if value.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=['GET', 'POST', 'PATCH'], allow_headers=['Content-Type'])

@app.exception_handler(SQLAlchemyError)
async def database_error(_request, _exc):
    return JSONResponse(status_code=503, content={'detail': 'Không thể truy cập cơ sở dữ liệu.'})

@app.exception_handler(RuntimeError)
async def configuration_error(_request, _exc):
    return JSONResponse(status_code=503, content={'detail': 'Cơ sở dữ liệu chưa sẵn sàng hoặc chưa được cấu hình.'})

@app.get('/api/health')
def health():
    try:
        with get_engine().connect() as conn:
            conn.execute(text('SELECT 1'))
        return {'status': 'ok', 'database': 'connected'}
    except (SQLAlchemyError, RuntimeError):
        return {'status': 'degraded', 'database': 'unavailable'}

def calibration_anchor_capability(connection) -> tuple[bool, bool]:
    """Inspect this connection's active schema without changing it or caching a result."""
    inspector = inspect(connection)
    if not inspector.has_table('calibrations'):
        return False, False
    return True, any(column['name'] == 'image_anchor' for column in inspector.get_columns('calibrations'))

@app.get('/api/capabilities')
def capabilities():
    try:
        with get_engine().connect() as connection:
            available, anchor = calibration_anchor_capability(connection)
        return {'status': 'ok' if available else 'degraded', 'imageAnchorV1': anchor}
    except (SQLAlchemyError, RuntimeError):
        return {'status': 'degraded', 'imageAnchorV1': False}

def has_calibration_anchor(db: DBSession) -> bool:
    return calibration_anchor_capability(db.connection())[1]

def legacy_calibration_columns():
    """Exclude optional columns on databases awaiting the additive migration."""
    return [column for column in models.Calibration.__table__.columns if column.name != 'image_anchor']

def legacy_calibration_row(row):
    return {**dict(row), 'image_anchor': None}

def require(db: DBSession, model, identity: int):
    obj = db.get(model, identity)
    if obj is None:
        raise HTTPException(status_code=404, detail='Không tìm thấy dữ liệu.')
    return obj

def save(db: DBSession, obj, action: str):
    db.add(obj)
    try:
        db.flush()
        db.add(models.AuditLog(entity_type=obj.__tablename__, entity_id=obj.id, action=action))
        db.commit()
        db.refresh(obj)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail='Dữ liệu trùng hoặc không hợp lệ.') from None
    return obj

def nonnullable_update(data, names):
    updates = data.model_dump(exclude_unset=True)
    if any(name in updates and updates[name] is None for name in names):
        raise HTTPException(status_code=422, detail='Trường bắt buộc không được để trống.')
    return updates

@app.get('/api/patients', response_model=list[schemas.PatientOut])
def patients(db: DBSession = Depends(get_db)):
    return db.scalars(select(models.Patient).order_by(models.Patient.created_at.desc(), models.Patient.id.desc())).all()

@app.post('/api/patients', response_model=schemas.PatientOut, status_code=201)
def create_patient(data: schemas.PatientCreate, db: DBSession = Depends(get_db)):
    return save(db, models.Patient(**data.model_dump()), 'create')

@app.get('/api/patients/{patient_id}', response_model=schemas.PatientOut)
def patient(patient_id: int, db: DBSession = Depends(get_db)):
    return require(db, models.Patient, patient_id)

@app.patch('/api/patients/{patient_id}', response_model=schemas.PatientOut)
def update_patient(patient_id: int, data: schemas.PatientUpdate, db: DBSession = Depends(get_db)):
    obj = require(db, models.Patient, patient_id)
    for key, value in nonnullable_update(data, ('research_code', 'affected_side', 'dominant_hand')).items():
        setattr(obj, key, value)
    return save(db, obj, 'update')

@app.get('/api/sessions', response_model=list[schemas.SessionOut])
def sessions(patient_id: int | None = Query(default=None, gt=0), db: DBSession = Depends(get_db)):
    query = select(models.Session)
    if patient_id is not None:
        query = query.where(models.Session.patient_id == patient_id)
    return db.scalars(query.order_by(models.Session.created_at.desc(), models.Session.id.desc())).all()

@app.post('/api/sessions', response_model=schemas.SessionOut, status_code=201)
def create_session(data: schemas.SessionCreate, db: DBSession = Depends(get_db)):
    require(db, models.Patient, data.patient_id)
    if data.status != 'draft' or data.started_at is not None or data.ended_at is not None:
        raise HTTPException(status_code=422, detail='Phiên mới phải ở trạng thái nháp; thời gian do hệ thống ghi.')
    return save(db, models.Session(**data.model_dump()), 'create')

@app.get('/api/sessions/{session_id}', response_model=schemas.SessionOut)
def session(session_id: int, db: DBSession = Depends(get_db)):
    return require(db, models.Session, session_id)

@app.patch('/api/sessions/{session_id}', response_model=schemas.SessionOut)
def update_session(session_id: int, data: schemas.SessionUpdate, db: DBSession = Depends(get_db)):
    # Serialize transitions for this row, so two requests cannot both act on an old status.
    obj = db.scalar(select(models.Session).where(models.Session.id == session_id).with_for_update())
    if obj is None:
        raise HTTPException(status_code=404, detail='Không tìm thấy dữ liệu.')
    values = nonnullable_update(data, ('affected_side', 'session_type', 'status'))
    if 'started_at' in values or 'ended_at' in values:
        raise HTTPException(status_code=422, detail='Thời gian phiên do hệ thống ghi.')
    transitions = {'draft': {'in_progress', 'cancelled'}, 'in_progress': {'completed', 'cancelled'}, 'completed': set(), 'cancelled': set()}
    target_status = values.get('status', obj.status)
    if target_status != obj.status and target_status not in transitions[obj.status]:
        raise HTTPException(status_code=409, detail='Không thể chuyển trạng thái phiên.')
    if values.get('status') in ('in_progress', 'completed') and obj.started_at is None and not values.get('started_at'):
        values['started_at'] = datetime.now(timezone.utc)
    if values.get('status') in ('completed', 'cancelled') and obj.ended_at is None and not values.get('ended_at'):
        values['ended_at'] = datetime.now(timezone.utc)
    combined = {key: getattr(obj, key) for key in ('patient_id', 'affected_side', 'session_type', 'status', 'started_at', 'ended_at', 'notes')}
    try:
        schemas.SessionCreate(**{**combined, **values})
    except ValueError as exc:
        raise HTTPException(status_code=422, detail='Thời gian phiên không hợp lệ.') from exc
    for key, value in values.items():
        setattr(obj, key, value)
    return save(db, obj, 'update')

@app.get('/api/calibrations', response_model=list[schemas.CalibrationOut])
def calibrations(session_id: int = Query(gt=0), db: DBSession = Depends(get_db)):
    require(db, models.Session, session_id)
    if not has_calibration_anchor(db):
        table = models.Calibration.__table__
        rows = db.execute(select(*legacy_calibration_columns()).where(table.c.session_id == session_id).order_by(table.c.created_at.desc(), table.c.id.desc())).mappings().all()
        return [legacy_calibration_row(row) for row in rows]
    return db.scalars(select(models.Calibration).where(models.Calibration.session_id == session_id).order_by(models.Calibration.created_at.desc(), models.Calibration.id.desc())).all()

@app.post('/api/calibrations', response_model=schemas.CalibrationOut, status_code=201)
def create_calibration(data: schemas.CalibrationCreate, db: DBSession = Depends(get_db)):
    require(db, models.Session, data.session_id)
    if not has_calibration_anchor(db):
        if data.image_anchor is not None:
            raise HTTPException(status_code=409, detail='Cơ sở dữ liệu chưa hỗ trợ neo hình ảnh; hãy nâng cấp schema trước.')
        try:
            table = models.Calibration.__table__
            row = db.execute(insert(table).values(**data.model_dump(exclude={'image_anchor'})).returning(*legacy_calibration_columns())).mappings().one()
            db.add(models.AuditLog(entity_type=table.name, entity_id=row['id'], action='create'))
            db.commit()
            return legacy_calibration_row(row)
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail='Dữ liệu trùng hoặc không hợp lệ.') from None
    return save(db, models.Calibration(**data.model_dump()), 'create')

@app.get('/api/calibrations/{calibration_id}', response_model=schemas.CalibrationOut)
def calibration(calibration_id: int, db: DBSession = Depends(get_db)):
    if not has_calibration_anchor(db):
        table = models.Calibration.__table__
        row = db.execute(select(*legacy_calibration_columns()).where(table.c.id == calibration_id)).mappings().one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail='Không tìm thấy dữ liệu.')
        return legacy_calibration_row(row)
    return require(db, models.Calibration, calibration_id)


def result_response(result: models.ExerciseResult) -> schemas.ExerciseResultOut:
    values = json.loads(result.result_json)
    values.pop('schema_version', None)
    return schemas.ExerciseResultOut(**values, id=result.id, trial_id=result.trial_id, created_at=result.created_at)


def existing_round(db: DBSession, data: schemas.ExerciseResultCreate):
    result = db.scalar(select(models.ExerciseResult).where(models.ExerciseResult.round_id == str(data.round_id)))
    if result is None:
        return None
    saved = result_response(result)
    if saved.model_dump(exclude={'id', 'trial_id', 'created_at'}) != data.model_dump():
        raise HTTPException(status_code=409, detail='Mã lượt đã được dùng cho kết quả khác.')
    return saved


@app.post('/api/exercise-results', response_model=schemas.ExerciseResultOut, status_code=201)
def create_exercise_result(data: schemas.ExerciseResultCreate, response: Response, db: DBSession = Depends(get_db)):
    # Serializing by session prevents a completion transition racing the save.
    session = db.scalar(select(models.Session).where(models.Session.id == data.session_id).with_for_update())
    if session is None:
        raise HTTPException(status_code=404, detail='Không tìm thấy phiên.')
    prior = existing_round(db, data)
    if prior is not None:
        response.status_code = 200
        return prior
    if session.status != 'in_progress':
        raise HTTPException(status_code=409, detail='Chỉ lưu kết quả khi phiên đang thực hiện.')
    trial = models.Trial(session_id=session.id, exercise_code=data.game_key)
    try:
        db.add(trial)
        db.flush()
        payload = {'schema_version': 1, **data.model_dump(mode='json')}
        result = models.ExerciseResult(trial_id=trial.id, round_id=str(data.round_id), result_json=json.dumps(payload, ensure_ascii=False, allow_nan=False))
        db.add(result)
        db.flush()
        db.add(models.AuditLog(entity_type='exercise_results', entity_id=result.id, action='create'))
        db.commit()
        db.refresh(result)
        return result_response(result)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail='Mã lượt đã tồn tại.') from None


@app.get('/api/exercise-results', response_model=list[schemas.ExerciseResultOut])
def exercise_results(session_id: int = Query(gt=0), db: DBSession = Depends(get_db)):
    require(db, models.Session, session_id)
    results = db.scalars(select(models.ExerciseResult).join(models.Trial).where(
        models.Trial.session_id == session_id,
        models.Trial.exercise_code == 'glowing_flower',
        models.ExerciseResult.round_id.is_not(None),
    ).order_by(models.ExerciseResult.created_at.desc(), models.ExerciseResult.id.desc())).all()
    return [result_response(result) for result in results]
