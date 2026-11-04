from datetime import datetime, timezone
from contextlib import asynccontextmanager
import asyncio
import json
import os
from typing import Literal
from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import inspect, insert, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session as DBSession
from .db import get_db, get_engine
from . import models, schemas
from .capture_lease_monitor import monitor, stop_monitor


@asynccontextmanager
async def lifespan(application):
    # Dependency-overridden test clients use isolated transactions and no monitor.
    task = asyncio.create_task(monitor()) if get_db not in application.dependency_overrides else None
    try:
        yield
    finally:
        await stop_monitor(task)


app = FastAPI(title='Rehabilitation AR - development only', version='0.1.0', lifespan=lifespan)
origins = [value.strip() for value in os.getenv('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174').split(',') if value.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=['GET', 'POST', 'PUT', 'PATCH'], allow_headers=['Content-Type', 'X-Chunk-SHA256'])

@app.middleware('http')
async def protect_browser_mutations(request, call_next):
    origin = request.headers.get('origin')
    if (request.url.path.startswith('/api/') and request.method in ('POST', 'PUT', 'PATCH', 'DELETE')
            and origin is not None and origin not in origins):
        return JSONResponse(status_code=403, content={'detail': 'Nguồn yêu cầu không được phép thay đổi dữ liệu.'})
    return await call_next(request)

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
    except SQLAlchemyError:
        db.rollback()
        raise
    return obj

def nonnullable_update(data, names):
    updates = data.model_dump(exclude_unset=True)
    if any(name in updates and updates[name] is None for name in names):
        raise HTTPException(status_code=422, detail='Trường bắt buộc không được để trống.')
    return updates

@app.get('/api/patients', response_model=list[schemas.PatientOut])
def patients(patient_type: Literal['outpatient', 'inpatient'] | None = None,
        search: str | None = Query(default=None, max_length=255), q: str | None = Query(default=None, max_length=255),
        db: DBSession = Depends(get_db)):
    query = select(models.Patient)
    if patient_type:
        query = query.where(models.Patient.patient_type == patient_type)
    term = (search or q or '').strip()
    if term:
        from sqlalchemy import or_
        pattern = '%' + term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        query = query.where(or_(models.Patient.research_code.ilike(pattern, escape='\\'), models.Patient.full_name.ilike(pattern, escape='\\')))
    return db.scalars(query.order_by(models.Patient.created_at.desc(), models.Patient.id.desc())).all()

@app.post('/api/patients', response_model=schemas.PatientOut, status_code=201)
def create_patient(data: schemas.PatientCreate, db: DBSession = Depends(get_db)):
    if data.patient_type != 'outpatient':
        raise HTTPException(422, 'Tạo hồ sơ đến khám trước, sau đó dùng chức năng chuyển nhóm để nhập viện và liên kết đánh giá đầu vào.')
    return save(db, models.Patient(**data.model_dump()), 'create')

@app.get('/api/patients/{patient_id}', response_model=schemas.PatientOut)
def patient(patient_id: int, db: DBSession = Depends(get_db)):
    return require(db, models.Patient, patient_id)

@app.patch('/api/patients/{patient_id}', response_model=schemas.PatientOut)
def update_patient(patient_id: int, data: schemas.PatientUpdate, db: DBSession = Depends(get_db)):
    obj = require(db, models.Patient, patient_id)
    for key, value in nonnullable_update(data, ('research_code', 'affected_side', 'dominant_hand', 'legacy_review_required')).items():
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
    if data.status != 'draft' or data.started_at is not None or data.ended_at is not None:
        raise HTTPException(status_code=422, detail='Phiên mới phải ở trạng thái nháp; thời gian do hệ thống ghi.')
    if data.session_type == 'training':
        # Old URLs use the same admission/setup rules as the daily workflow.
        from .workflow_schemas import DomainSessionCreate
        from .workflow_sessions import create_domain_session
        return create_domain_session(db, DomainSessionCreate(patient_id=data.patient_id, notes=data.notes), 'training')
    require(db, models.Patient, data.patient_id)
    return save(db, models.Session(**data.model_dump()), 'create')

@app.get('/api/sessions/{session_id}', response_model=schemas.SessionOut)
def session(session_id: int, db: DBSession = Depends(get_db)):
    return require(db, models.Session, session_id)

@app.patch('/api/sessions/{session_id}', response_model=schemas.SessionOut)
def update_session(session_id: int, data: schemas.SessionUpdate, db: DBSession = Depends(get_db)):
    # Serialize transitions for this row, so two requests cannot both act on an old status.
    obj = db.scalar(select(models.Session).where(models.Session.id == session_id).with_for_update().execution_options(populate_existing=True))
    if obj is None:
        raise HTTPException(status_code=404, detail='Không tìm thấy dữ liệu.')
    values = nonnullable_update(data, ('affected_side', 'session_type', 'status'))
    if 'started_at' in values or 'ended_at' in values:
        raise HTTPException(status_code=422, detail='Thời gian phiên do hệ thống ghi.')
    protected = db.scalar(select(models.PatientTransfer.id).where(models.PatientTransfer.baseline_assessment_session_id == obj.id).limit(1))
    if protected is not None and any(key in values and values[key] != getattr(obj, key) for key in ('session_type', 'status', 'affected_side')):
        raise HTTPException(409, 'Đánh giá đầu vào đã liên kết nhập viện; không thay đổi loại, trạng thái hoặc tay đánh giá.')
    if values.get('session_type', obj.session_type) != obj.session_type:
        raise HTTPException(409, 'Không đổi loại phiên đã tạo. Bắt đầu một lần đánh giá hoặc buổi tập trong phân hệ tương ứng.')
    if obj.session_type == 'training' and values.get('status') == 'in_progress':
        if require(db, models.Patient, obj.patient_id).patient_type != 'inpatient':
            raise HTTPException(409, 'Chỉ bệnh nhân điều trị được bắt đầu luyện tập. Hãy đánh giá và chuyển nhóm trước.')
    if obj.managed_workflow:
        from .workflow_common import complete_session, start_session
        from .workflow_sessions import cancel_pending_trials
        if obj.status in ('completed', 'cancelled') and values:
            if values == {'status': obj.status}:
                return obj
            raise HTTPException(409, 'Buổi đã kết thúc; dữ liệu được bảo toàn.')
        if values.get('session_type', obj.session_type) != obj.session_type:
            raise HTTPException(422, 'Không thay đổi loại quy trình sau khi đã tạo.')
        if values.get('affected_side', obj.affected_side) != obj.affected_side:
            obj.affected_side = values['affected_side']
            obj.setup_confirmed = False
            obj.setup_revision += 1
            cancel_pending_trials(db, obj.id)
        target = values.get('status', obj.status)
        if target == 'in_progress':
            start_session(db, obj)
        elif target == 'completed':
            complete_session(db, obj)
        elif target == 'cancelled':
            cancel_pending_trials(db, obj.id)
            obj.status, obj.ended_at, obj.setup_confirmed = 'cancelled', datetime.now(timezone.utc), False
        elif target != obj.status:
            raise HTTPException(409, 'Không thể chuyển trạng thái phiên.')
        if 'notes' in values:
            obj.notes = values['notes']
        return save(db, obj, 'update')
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
    session = require(db, models.Session, data.session_id)
    if getattr(session, 'managed_workflow', False):
        from .workflow_common import locked_session
        session = locked_session(db, session.id)
        if session.status in ('completed', 'cancelled'):
            raise HTTPException(409, 'Buổi đã kết thúc.')
        if data.setup_revision is None or data.setup_revision != session.setup_revision:
            raise HTTPException(409, 'Cấu hình camera đã thay đổi; kiểm tra và xác nhận lại.')
        if not data.confirmed or not data.ghost_visible or not data.camera_device_id or not data.width or not data.height:
            raise HTTPException(422, 'Cần camera trực tiếp, hình bóng và xác nhận tư thế của nhân viên trước khi lưu.')
        if data.affected_side != session.affected_side:
            raise HTTPException(422, 'Tay hiệu chuẩn không khớp với lần đánh giá hoặc buổi tập.')
        session.setup_confirmed = True
    if not has_calibration_anchor(db):
        if data.image_anchor is not None:
            raise HTTPException(status_code=409, detail='Cơ sở dữ liệu chưa hỗ trợ neo hình ảnh; hãy nâng cấp schema trước.')
        try:
            table = models.Calibration.__table__
            row = db.execute(insert(table).values(**data.model_dump(exclude={'image_anchor', 'setup_revision'})).returning(*legacy_calibration_columns())).mappings().one()
            db.add(models.AuditLog(entity_type=table.name, entity_id=row['id'], action='create'))
            db.commit()
            return legacy_calibration_row(row)
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail='Dữ liệu trùng hoặc không hợp lệ.') from None
    return save(db, models.Calibration(**data.model_dump(exclude={'setup_revision'})), 'create')

@app.get('/api/calibrations/{calibration_id}', response_model=schemas.CalibrationOut)
def calibration(calibration_id: int, db: DBSession = Depends(get_db)):
    if not has_calibration_anchor(db):
        table = models.Calibration.__table__
        row = db.execute(select(*legacy_calibration_columns()).where(table.c.id == calibration_id)).mappings().one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail='Không tìm thấy dữ liệu.')
        return legacy_calibration_row(row)
    return require(db, models.Calibration, calibration_id)


def result_response(result: models.ExerciseResult, trial=None) -> schemas.ExerciseResultOut:
    values = json.loads(result.result_json)
    values.pop('schema_version', None)
    values.pop('trial_id', None)
    if trial is not None:
        values['exercise_id'], values['exercise_code'] = trial.exercise_id, trial.exercise_code
    return schemas.ExerciseResultOut(**values, id=result.id, trial_id=result.trial_id, created_at=result.created_at)


def existing_round(db: DBSession, data: schemas.ExerciseResultCreate):
    result = db.scalar(select(models.ExerciseResult).where(models.ExerciseResult.round_id == str(data.round_id)))
    if result is None:
        return None
    saved = result_response(result, db.get(models.Trial, result.trial_id))
    if saved.model_dump(exclude={'id', 'trial_id', 'created_at', 'exercise_id', 'exercise_code'}) != data.model_dump(exclude={'trial_id'}) or (data.trial_id is not None and data.trial_id != result.trial_id):
        raise HTTPException(status_code=409, detail='Mã lượt đã được dùng cho kết quả khác.')
    return saved


@app.post('/api/exercise-results', response_model=schemas.ExerciseResultOut, response_model_exclude_none=True, status_code=201)
def create_exercise_result(data: schemas.ExerciseResultCreate, response: Response, db: DBSession = Depends(get_db)):
    # Serializing by session prevents a completion transition racing the save.
    session = db.scalar(select(models.Session).where(models.Session.id == data.session_id).with_for_update().execution_options(populate_existing=True))
    if session is None:
        raise HTTPException(status_code=404, detail='Không tìm thấy phiên.')
    prior = existing_round(db, data)
    if prior is not None:
        response.status_code = 200
        return prior
    if session.status != 'in_progress':
        raise HTTPException(status_code=409, detail='Chỉ lưu kết quả khi phiên đang thực hiện.')
    if session.session_type == 'training' and require(db, models.Patient, session.patient_id).patient_type != 'inpatient':
        raise HTTPException(409, 'Chỉ bệnh nhân điều trị được luyện tập. Các kết quả cũ vẫn được giữ nguyên.')
    trial = db.get(models.Trial, data.trial_id) if data.trial_id is not None else None
    if session.managed_workflow:
        from .workflow_common import authorize_exercise, ensure_session_ready
        ensure_session_ready(db, session)
        if trial is None or trial.session_id != session.id or trial.exercise_id is None:
            raise HTTPException(422, 'Cần lượt đã bắt đầu trong đúng buổi hiện tại.')
        exercise = authorize_exercise(db, session, trial.exercise_id)
        expected_game = 'free_drawing' if exercise.renderer == 'free_drawing' else 'glowing_flower'
        if data.game_key != expected_game:
            raise HTTPException(422, 'Loại kết quả không khớp bài tập của lượt.')
        if trial.status != 'in_progress':
            raise HTTPException(409, 'Lượt đã hoàn tất hoặc bị hủy.')
        if data.affected_side != session.affected_side:
            raise HTTPException(422, 'Tay thực hiện không khớp với buổi hiện tại.')
        if trial.client_round_id is not None and trial.client_round_id != str(data.round_id):
            raise HTTPException(409, 'Mã kết quả không khớp lượt đã bắt đầu.')
    elif data.trial_id is not None and (trial is None or trial.session_id != session.id):
        raise HTTPException(422, 'Lượt không thuộc phiên hiện tại.')
    if data.game_key == 'free_drawing' and (session.session_type != 'training' or not session.managed_workflow):
        raise HTTPException(422, 'Vẽ tự do chỉ lưu trong buổi luyện tập đã chuẩn bị.')
    if trial is None:
        from .workflow_common import next_trial_number
        catalog = db.scalar(select(models.ExerciseCatalog).where(models.ExerciseCatalog.code == data.game_key))
        trial = models.Trial(session_id=session.id, exercise_code=data.game_key,
            exercise_id=catalog.id if catalog else None, trial_number=next_trial_number(db, session.id))
    try:
        db.add(trial)
        db.flush()
        trial.status, trial.ended_at = 'completed', datetime.now(timezone.utc)
        payload = {'schema_version': 1, **data.model_dump(mode='json', exclude={'trial_id'}, exclude_none=True)}
        result = models.ExerciseResult(trial_id=trial.id, round_id=str(data.round_id), result_json=json.dumps(payload, ensure_ascii=False, allow_nan=False))
        db.add(result)
        db.flush()
        db.add(models.AuditLog(entity_type='exercise_results', entity_id=result.id, action='create'))
        db.commit()
        db.refresh(result)
        return result_response(result, trial)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail='Mã lượt đã tồn tại.') from None
    except SQLAlchemyError:
        db.rollback()
        raise


@app.get('/api/exercise-results', response_model=list[schemas.ExerciseResultOut], response_model_exclude_none=True)
def exercise_results(session_id: int = Query(gt=0), db: DBSession = Depends(get_db)):
    require(db, models.Session, session_id)
    results = db.scalars(select(models.ExerciseResult).join(models.Trial).where(
        models.Trial.session_id == session_id,
        models.ExerciseResult.round_id.is_not(None),
    ).order_by(models.ExerciseResult.created_at.desc(), models.ExerciseResult.id.desc())).all()
    return [result_response(result, db.get(models.Trial, result.trial_id)) for result in results]

from .captures import router as capture_router
app.include_router(capture_router)
from .benchmarks import router as benchmark_router
app.include_router(benchmark_router)
from .workflow_patients import router as patients_router
from .questionnaires import router as questionnaires_router
from .workflow_catalog import router as catalog_router
from .workflow_sessions import router as sessions_router
from .workflow_reports import router as reports_router
for domain_router in (patients_router, questionnaires_router, catalog_router, sessions_router, reports_router):
    app.include_router(domain_router)
