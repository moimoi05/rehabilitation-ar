"""Development-only localhost capture API; no clinical authentication is provided."""
import csv
import hashlib
import io
import json
import os
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4
import pyarrow as pa
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from . import models
from .db import get_db
from .capture_schemas import CaptureCreate, CaptureFinalize, LandmarkBatch, RecorderStart
from .capture_storage import MAX_BATCH_BYTES, MAX_CHUNK_BYTES, capture_path, convert_landmarks, enough_space, put_idempotent, sha256_file

router = APIRouter(prefix='/api')
LEASE_SECONDS = 120
LEASE_EXPIRED = 'Capture lease expired; recording may be incomplete'


def local_only(request: Request):
    if request.client is None or request.client.host not in ('127.0.0.1', '::1', 'testclient'):
        raise HTTPException(403, 'Capture API is available only on localhost; authentication is not implemented')


def get_capture(db, capture_id, lock=False):
    query = select(models.CaptureRun).where(models.CaptureRun.id == str(capture_id))
    if lock:
        query = query.with_for_update()
    capture = db.scalar(query)
    if capture is None:
        raise HTTPException(404, 'Capture not found')
    return capture


def describe(capture):
    return {column.name: getattr(capture, column.name) for column in models.CaptureRun.__table__.columns}


def ensure_recording(capture, db, allow_expired=False):
    if capture.status not in ('recording', 'incomplete'):
        raise HTTPException(409, 'Capture is not accepting data')
    if capture.status == 'recording' and capture.lease_expires_at is not None:
        if capture.lease_expires_at <= db.scalar(select(func.clock_timestamp())):
            capture.status = 'incomplete'
            capture.error_message = LEASE_EXPIRED
            db.commit()
    if not allow_expired and capture.status == 'incomplete' and capture.error_message == LEASE_EXPIRED:
        raise HTTPException(409, 'Capture lease expired; staged data retained')


def reconcile_expired(db, limit=256):
    """Expire only elapsed leases; locked active captures are left for a later pass."""
    expired = db.scalars(select(models.CaptureRun).where(
        models.CaptureRun.status == 'recording', models.CaptureRun.lease_expires_at.is_not(None),
        models.CaptureRun.lease_expires_at <= func.clock_timestamp(),
    ).with_for_update(skip_locked=True).limit(limit)).all()
    for capture in expired:
        capture.status = 'incomplete'
        capture.error_message = LEASE_EXPIRED
    db.flush()
    return len(expired)


async def bounded_body(request, maximum):
    length = request.headers.get('content-length')
    if length and (not length.isdecimal() or int(length) > maximum):
        raise HTTPException(413, 'Request too large')
    pieces, size = [], 0
    async for piece in request.stream():
        size += len(piece)
        if size > maximum:
            raise HTTPException(413, 'Request too large')
        pieces.append(piece)
    return b''.join(pieces)


@router.post('/captures', status_code=201, dependencies=[Depends(local_only)])
def create_capture(data: CaptureCreate, db: Session = Depends(get_db)):
    session = db.get(models.Session, data.session_id)
    if session is None or session.patient_id != data.patient_id:
        raise HTTPException(422, 'Patient and session do not match')
    trial = db.get(models.Trial, data.trial_id) if data.trial_id else None
    if data.trial_id and (trial is None or trial.session_id != session.id):
        raise HTTPException(422, 'Trial and session do not match')
    if trial is None:
        trial = models.Trial(session_id=session.id, exercise_code=data.exercise_code)
        db.add(trial)
        db.flush()
    identity = str(uuid4())
    try:
        enough_space(capture_path(identity), 0)
    except OSError as exc:
        raise HTTPException(507, 'Private storage unavailable or insufficient space') from exc
    values = data.model_dump(exclude={'trial_id', 'exercise_code'})
    capture = models.CaptureRun(id=identity, trial_id=trial.id, status='recording',
                                lease_expires_at=func.clock_timestamp() + timedelta(seconds=LEASE_SECONDS), **values)
    db.add(capture)
    db.commit()
    db.refresh(capture)
    return describe(capture)


@router.get('/captures/{capture_id}', dependencies=[Depends(local_only)])
def capture_status(capture_id: UUID, db: Session = Depends(get_db)):
    return describe(get_capture(db, capture_id))


@router.get('/sessions/{session_id}/captures', dependencies=[Depends(local_only)])
def list_captures(session_id: int, db: Session = Depends(get_db)):
    return [describe(c) for c in db.scalars(select(models.CaptureRun).where(models.CaptureRun.session_id == session_id).order_by(models.CaptureRun.created_at)).all()]


@router.post('/captures/{capture_id}/heartbeat', dependencies=[Depends(local_only)])
def heartbeat(capture_id: UUID, db: Session = Depends(get_db)):
    capture = get_capture(db, capture_id, True)
    ensure_recording(capture, db)
    if capture.status != 'recording' or capture.lease_expires_at is None:
        raise HTTPException(409, 'Capture does not have an active lease')
    capture.lease_expires_at = func.clock_timestamp() + timedelta(seconds=LEASE_SECONDS)
    db.commit()
    db.refresh(capture)
    return describe(capture)


@router.post('/captures/{capture_id}/recorder-start', dependencies=[Depends(local_only)])
def recorder_start(capture_id: UUID, data: RecorderStart, db: Session = Depends(get_db)):
    capture = get_capture(db, capture_id, True)
    ensure_recording(capture, db)
    if capture.source_type != 'webcam' or not capture.record_video:
        raise HTTPException(409, 'MediaRecorder metadata is only valid for webcam video capture')
    if data.started_at_utc < capture.started_at_utc or data.start_performance_ms < capture.start_performance_ms:
        raise HTTPException(422, 'Recorder start precedes capture start')
    if data.mime_type.split(';')[0].strip().lower() != capture.video_mime_type.split(';')[0].strip().lower():
        raise HTTPException(422, 'Recorder MIME type does not match the video container')
    actual = {'start_performance_ms': data.start_performance_ms,
              'started_at_utc': data.started_at_utc.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
              'mime_type': data.mime_type}
    config = capture.model_config_info or {}
    existing = config.get('recorder_start')
    if existing is not None and existing != actual:
        raise HTTPException(409, 'Recorder start metadata already differs')
    if existing is None:
        capture.model_config_info = {**config, 'recorder_start': actual}
        capture.video_mime_type = data.mime_type
        db.commit()
    return describe(capture)


@router.post('/captures/{capture_id}/landmark-batches', dependencies=[Depends(local_only)])
async def upload_batch(capture_id: UUID, request: Request, db: Session = Depends(get_db)):
    data = await bounded_body(request, MAX_BATCH_BYTES)
    try:
        batch = LandmarkBatch.model_validate_json(data)
    except ValidationError as exc:
        raise HTTPException(422, 'Invalid landmark batch') from exc
    capture = get_capture(db, capture_id, True)
    ensure_recording(capture, db)
    if not capture.record_landmarks:
        raise HTTPException(409, 'Landmarks not selected')
    path = capture_path(capture_id) / 'staging' / 'batches' / f'{batch.batch_index}.json'
    try:
        enough_space(path.parent, len(data))
        canonical = batch.model_dump_json().encode('utf-8')
        created = put_idempotent(path, canonical)
        put_idempotent(path.with_suffix('.sha256'), hashlib.sha256(canonical).hexdigest().encode('ascii'))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(507, 'Unable to store batch') from exc
    db.commit()
    return {'batch_index': batch.batch_index, 'stored': created, 'frame_count': len(batch.frames)}


@router.put('/captures/{capture_id}/video-chunks/{index}', dependencies=[Depends(local_only)])
async def upload_chunk(capture_id: UUID, index: int, request: Request, db: Session = Depends(get_db)):
    if index < 0 or index > 1000000:
        raise HTTPException(422, 'Invalid chunk index')
    data = await bounded_body(request, MAX_CHUNK_BYTES)
    digest = request.headers.get('x-chunk-sha256', '').lower()
    if not data or hashlib.sha256(data).hexdigest() != digest:
        raise HTTPException(422, 'Chunk checksum mismatch')
    capture = get_capture(db, capture_id, True)
    ensure_recording(capture, db)
    if not capture.record_video or request.headers.get('content-type', '').split(';')[0].lower() != capture.video_mime_type.split(';')[0].lower():
        raise HTTPException(422, 'Video MIME type does not match capture')
    path = capture_path(capture_id) / 'staging' / 'chunks' / f'{index}.chunk'
    try:
        enough_space(path.parent, len(data))
        created = put_idempotent(path, data)
        put_idempotent(path.with_suffix('.sha256'), digest.encode('ascii'))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(507, 'Unable to store chunk') from exc
    db.commit()
    return {'index': index, 'sha256': digest, 'stored': created, 'size_bytes': len(data)}


class StagedFiles:
    """Reiterable ordered paths without retaining a path object for every part."""
    def __init__(self, folder, suffix, count):
        self.folder, self.suffix, self.count = folder, suffix, count

    def __len__(self):
        return self.count

    def __iter__(self):
        return (self.folder / f'{index}.{self.suffix}' for index in range(self.count))


def expected_files(folder, suffix, count):
    seen = 0
    ending = f'.{suffix}'
    if folder.exists():
        with os.scandir(folder) as entries:
            for entry in entries:
                if not entry.name.endswith(ending):
                    continue
                index = entry.name[:-len(ending)]
                # Bound parsing work and require the exact canonical decimal spelling.
                if (not entry.is_file(follow_symlinks=False) or not index.isascii()
                        or not index.isdecimal() or len(index) > len(str(count))
                        or str(int(index)) != index or int(index) >= count):
                    raise ValueError('Missing or unexpected staged parts')
                seen += 1
    if seen != count:
        raise ValueError('Missing or unexpected staged parts')
    return StagedFiles(folder, suffix, count)


@router.post('/captures/{capture_id}/finalize', dependencies=[Depends(local_only)])
def finalize(capture_id: UUID, data: CaptureFinalize, db: Session = Depends(get_db)):
    capture = get_capture(db, capture_id, True)
    return finalize_locked(capture, capture_id, data, db, recovery=False)


@router.post('/captures/{capture_id}/recover-finalize', dependencies=[Depends(local_only)])
def recover_finalize(capture_id: UUID, data: CaptureFinalize, db: Session = Depends(get_db)):
    """Finalize known complete staging after expiry without reviving its upload lease."""
    capture = get_capture(db, capture_id, True)
    return finalize_locked(capture, capture_id, data, db, recovery=True)


def finalize_locked(capture, capture_id, data, db, recovery):
    # The caller holds the row lock for the entire verification and commit.
    if capture.status == 'complete':
        summary = capture.artifact_summary or {}
        if (summary.get('batch_count') == data.expected_batches
                and summary.get('video_chunk_count') == data.expected_video_chunks
                and capture.ended_at_utc == data.ended_at_utc
                and capture.duration_ms == data.duration_ms):
            return describe(capture)
        raise HTTPException(409, 'Capture already finalized with different metadata')
    if recovery:
        # Do not release the row lock by committing on expiry: no old uploader may
        # race the recovery while the same staged parts are being verified.
        expired = (capture.status == 'recording' and capture.lease_expires_at is not None
                   and capture.lease_expires_at <= db.scalar(select(func.clock_timestamp())))
        if expired:
            capture.status, capture.error_message = 'incomplete', LEASE_EXPIRED
        if capture.status != 'incomplete' or capture.error_message != LEASE_EXPIRED:
            raise HTTPException(409, 'Only lease-expired captures may be recovered')
    else:
        ensure_recording(capture, db)
    folder = capture_path(capture_id)
    summary = {'schema_version': 1, 'batch_count': data.expected_batches,
               'video_chunk_count': data.expected_video_chunks,
               'frames_status': 'pending' if capture.record_landmarks else 'not_requested',
               'landmarks_status': 'pending' if capture.record_landmarks else 'not_requested',
               'video_status': 'pending' if capture.record_video else 'not_requested'}
    stage = 'validation'
    try:
        if data.ended_at_utc < capture.started_at_utc:
            raise ValueError('End time precedes start time')
        if capture.source_type == 'webcam' and capture.record_video and not (capture.model_config_info or {}).get('recorder_start'):
            raise ValueError('Recorder start metadata is missing')
        if capture.record_landmarks != (data.expected_batches > 0) or capture.record_video != (data.expected_video_chunks > 0):
            raise ValueError('Required artifact parts are missing')
        batches = expected_files(folder / 'staging' / 'batches', 'json', data.expected_batches)
        chunks = expected_files(folder / 'staging' / 'chunks', 'chunk', data.expected_video_chunks)
        if capture.record_landmarks:
            stage = 'landmarks'
            for part in batches:
                digest_path = part.with_suffix('.sha256')
                if not digest_path.is_file() or sha256_file(part) != digest_path.read_text(encoding='ascii'):
                    raise ValueError('Landmark batch integrity check failed')
            summary.update(convert_landmarks(folder, batches, capture.id, capture.patient_id, capture.session_id, capture.trial_id))
            summary.update(frames_status='complete', landmarks_status='complete',
                           frames_size_bytes=(folder / 'frames.parquet').stat().st_size,
                           landmarks_size_bytes=(folder / 'landmarks.parquet').stat().st_size)
        if capture.record_video:
            stage = 'video'
            extension = {'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv'}[capture.video_mime_type.split(';')[0].strip().lower()]
            video = folder / f'video.{extension}'
            temporary_video = folder / f'video.{extension}.tmp'
            enough_space(folder, sum(part.stat().st_size for part in chunks))
            with temporary_video.open('wb') as target:
                for part in chunks:
                    digest_path = part.with_suffix('.sha256')
                    if not digest_path.is_file() or sha256_file(part) != digest_path.read_text(encoding='ascii'):
                        raise ValueError('Video chunk integrity check failed')
                    with part.open('rb') as source:
                        for block in iter(lambda: source.read(1024 * 1024), b''):
                            target.write(block)
            if temporary_video.stat().st_size != sum(part.stat().st_size for part in chunks):
                raise ValueError('Video size verification failed')
            temporary_video.replace(video)
            summary.update(video_status='complete', video_file=video.name, video_size_bytes=video.stat().st_size, video_sha256=sha256_file(video))
            db.add(models.VideoRecord(trial_id=capture.trial_id, storage_reference=f'{capture.id}/{video.name}', consent_recorded=True))
        if capture.record_landmarks:
            db.add(models.LandmarkRecord(trial_id=capture.trial_id, storage_reference=f'{capture.id}/landmarks.parquet', format='parquet', model_version=None))
        capture.artifact_summary = summary
        capture.ended_at_utc = data.ended_at_utc
        capture.duration_ms = data.duration_ms
        capture.status = 'complete'
        capture.error_message = None
        db.commit()
        return describe(capture)
    except (ValueError, OSError, pa.ArrowException) as exc:
        capture.status = 'incomplete'
        if stage == 'landmarks':
            summary.update(frames_status='failed', landmarks_status='failed')
        elif stage == 'video':
            summary['video_status'] = 'failed'
        capture.artifact_summary = summary
        # Keep the expiry marker so a failed recovery cannot revive old uploads.
        capture.error_message = LEASE_EXPIRED if recovery else str(exc)[:1000]
        db.commit()
        raise HTTPException(409, 'Capture incomplete; staged data retained') from exc


@router.post('/captures/{capture_id}/abort', dependencies=[Depends(local_only)])
def abort(capture_id: UUID, db: Session = Depends(get_db)):
    capture = get_capture(db, capture_id, True)
    ensure_recording(capture, db, allow_expired=True)
    capture.status = 'aborted'
    capture.ended_at_utc = datetime.now(timezone.utc)
    db.commit()
    return describe(capture)


@router.get('/captures/{capture_id}/artifacts/{kind}', dependencies=[Depends(local_only)])
def download(capture_id: UUID, kind: str, db: Session = Depends(get_db)):
    capture = get_capture(db, capture_id)
    if capture.status != 'complete' or kind not in ('video', 'frames', 'landmarks'):
        raise HTTPException(404, 'Artifact unavailable')
    name = capture.artifact_summary.get('video_file') if kind == 'video' else f'{kind}.parquet'
    if not name or not (capture_path(capture_id) / name).is_file():
        raise HTTPException(404, 'Artifact unavailable')
    return FileResponse(capture_path(capture_id) / name, filename=name, media_type=capture.video_mime_type if kind == 'video' else 'application/octet-stream')


@router.get('/sessions/{session_id}/video-manifest', dependencies=[Depends(local_only)])
def manifest(session_id: int, db: Session = Depends(get_db)):
    captures = db.scalars(select(models.CaptureRun).where(models.CaptureRun.session_id == session_id, models.CaptureRun.status == 'complete')).all()
    output = io.StringIO(newline='')
    fields = ['capture_id', 'patient_id', 'session_id', 'trial_id', 'source_type',
              'started_at_utc', 'ended_at_utc', 'duration_ms', 'width', 'height', 'model_config_json',
              'video_mime_type', 'video_size_bytes', 'video_sha256', 'video_url', 'frames_url', 'landmarks_url']
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for capture in captures:
        info = capture.artifact_summary or {}
        artifact_base = f'/api/captures/{capture.id}/artifacts'
        writer.writerow(dict(capture_id=capture.id, patient_id=capture.patient_id, session_id=capture.session_id,
                             trial_id=capture.trial_id, source_type=capture.source_type,
                             started_at_utc=capture.started_at_utc.isoformat(),
                             ended_at_utc=capture.ended_at_utc.isoformat() if capture.ended_at_utc else None,
                             duration_ms=capture.duration_ms, width=capture.width, height=capture.height,
                             model_config_json=json.dumps(capture.model_config_info, ensure_ascii=False, separators=(',', ':')),
                             video_mime_type=capture.video_mime_type, video_size_bytes=info.get('video_size_bytes'),
                             video_sha256=info.get('video_sha256'), video_url=f'{artifact_base}/video' if capture.record_video else None,
                             frames_url=f'{artifact_base}/frames' if capture.record_landmarks else None,
                             landmarks_url=f'{artifact_base}/landmarks' if capture.record_landmarks else None))
    output.seek(0)
    return StreamingResponse(iter([output.getvalue()]), media_type='text/csv', headers={'Content-Disposition':'attachment; filename="video_manifest.csv"'})
