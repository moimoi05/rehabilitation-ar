from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pyarrow as pa
import pytest
from fastapi import HTTPException

from app import captures
from app.capture_schemas import CaptureFinalize


def test_expected_files_checks_large_missing_count_without_materializing_paths(tmp_path):
    # A valid but very large client-supplied count must not allocate a million Paths.
    import tracemalloc
    folder = tmp_path / 'batches'
    folder.mkdir()
    (folder / '0.json').write_text('{}')
    tracemalloc.start()
    try:
        with pytest.raises(ValueError, match='Missing or unexpected'):
            captures.expected_files(folder, 'json', 10_000)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 512 * 1024


def test_expected_files_rejects_noncanonical_and_unexpected_parts(tmp_path):
    (tmp_path / '0.json').write_text('{}')
    assert list(captures.expected_files(tmp_path, 'json', 1)) == [tmp_path / '0.json']
    (tmp_path / '01.json').write_text('{}')
    with pytest.raises(ValueError, match='Missing or unexpected'):
        captures.expected_files(tmp_path, 'json', 1)


def test_arrow_conversion_failure_marks_capture_incomplete_and_retains_batch(tmp_path, monkeypatch):
    capture_id = uuid4()
    batch_dir = tmp_path / 'staging' / 'batches'
    batch_dir.mkdir(parents=True)
    batch = batch_dir / '0.json'
    batch.write_text('{}')
    capture = SimpleNamespace(id=str(capture_id), patient_id=1, session_id=2, trial_id=3,
                              started_at_utc=datetime(2026, 1, 1, tzinfo=timezone.utc),
                              status='recording', source_type='pre_recorded_video', record_landmarks=True, record_video=False,
                              lease_expires_at=None, model_config_info={})
    db = SimpleNamespace(commit=lambda: None)
    monkeypatch.setattr(captures, 'get_capture', lambda *args: capture)
    monkeypatch.setattr(captures, 'capture_path', lambda _: tmp_path)
    def fail(*args):
        raise pa.ArrowException('conversion failed')
    monkeypatch.setattr(captures, 'convert_landmarks', fail)
    data = CaptureFinalize(expected_batches=1, expected_video_chunks=0,
                           ended_at_utc='2026-01-01T00:01:00Z', duration_ms=1000)
    with pytest.raises(HTTPException) as result:
        captures.finalize(capture_id, data, db)
    assert result.value.status_code == 409
    assert capture.status == 'incomplete'
    assert batch.read_text() == '{}'
