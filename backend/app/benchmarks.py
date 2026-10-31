"""Loopback-only bounded artifact API. No clinical database dependencies."""
import asyncio
import ipaddress
import json
import re
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.parse import urlsplit
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from . import benchmark_storage as storage

CHUNK_LIMIT = 8 * 1024 * 1024
LIMITS = {'annotated.webm': 1024**3, 'recording.webm': 1024**3, 'annotated.mp4': 1024**3,
          'landmarks.jsonl': 512 * 1024**2, 'fps.csv': 16 * 1024**2, 'summary.json': 1024**2}
RUN_PATTERN = re.compile(r'^\d{8}T\d{6}Z-[a-f0-9]{32}$')


def local_only(request: Request):
    host = request.client.host if request.client else ''
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = False
    if not local or request.url.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise HTTPException(403, 'Benchmark API accepts loopback clients and local hosts only')
    origin = request.headers.get('origin')
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1') or parsed.port not in (5173, 8001):
            raise HTTPException(403, 'Benchmark API rejects this browser origin')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-site benchmark access is not allowed')


router = APIRouter(prefix='/api/benchmarks', dependencies=[Depends(local_only)])


def run_folder(run_id):
    if not RUN_PATTERN.fullmatch(run_id):
        raise HTTPException(422, 'Invalid benchmark run ID')
    folder = (storage.root() / run_id).resolve()
    if folder.parent != storage.root() or not folder.is_dir():
        raise HTTPException(404, 'Benchmark run does not exist')
    return folder


@contextmanager
def exclusive(folder):
    try:
        handle = (folder / '.busy').open('x')
    except FileExistsError:
        raise HTTPException(409, 'Another upload/finalization is in progress') from None
    try:
        if (folder / 'manifest.json').exists():
            raise HTTPException(409, 'Finalized runs are immutable; create a new run')
        yield
    finally:
        handle.close()
        (folder / '.busy').unlink(missing_ok=True)


async def json_body(request, limit=65536):
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise HTTPException(413, 'JSON body too large')
        data.extend(chunk)
    try:
        value = json.loads(data or b'{}')
        if not isinstance(value, dict):
            raise ValueError('Expected a JSON object')
        return value
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get('/source')
def source():
    try:
        with storage.SOURCE.open('rb'):
            pass
    except OSError as exc:
        raise HTTPException(404, str(exc)) from None
    # Starlette FileResponse implements byte ranges for seeking/replay.
    return FileResponse(storage.SOURCE, media_type='video/mp4', headers={'Cache-Control': 'no-store'})


@router.get('/source-info')
def source_info():
    try:
        return storage.source_info()
    except OSError as exc:
        raise HTTPException(404, str(exc)) from None


@router.post('/runs', status_code=201)
async def create_run(request: Request):
    config = await json_body(request)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid4().hex
    folder = storage.root() / run_id
    folder.mkdir(parents=True, exist_ok=False)
    storage.write_json(folder / 'configuration.json', {**config, 'created_at': datetime.now(timezone.utc).isoformat()})
    return {'run_id': run_id, 'directory': str(folder)}


@router.put('/runs/{run_id}/artifacts/{name}')
async def upload(run_id: str, name: str, request: Request, offset: int = Query(ge=0)):
    if name not in LIMITS:
        raise HTTPException(422, 'Artifact name is not allowed')
    folder = run_folder(run_id)
    path = folder / name
    if path.is_symlink() or path.resolve().parent != folder:
        raise HTTPException(403, 'Artifact path is outside the run directory')
    with exclusive(folder):
        current = path.stat().st_size if path.exists() else 0
        if current != offset:
            raise HTTPException(409, f'Expected offset {current}')
        written = 0
        with path.open('ab') as handle:
            try:
                async for chunk in request.stream():
                    written += len(chunk)
                    if written > CHUNK_LIMIT or current + written > LIMITS[name]:
                        raise HTTPException(413, 'Artifact/chunk size limit exceeded')
                    handle.write(chunk)
            except BaseException:
                handle.truncate(current)
                raise
        return {'size': current + written}


@router.post('/runs/{run_id}/finalize')
async def finalize(run_id: str, request: Request):
    value = await json_body(request)
    error = value.get('error')
    if error is not None and (not isinstance(error, str) or len(error) > 16000):
        raise HTTPException(422, 'error must be a string of at most 16000 characters')
    folder = run_folder(run_id)
    with exclusive(folder):
        return await asyncio.to_thread(storage.finalize, folder, error)
