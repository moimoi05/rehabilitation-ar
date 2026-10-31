import pytest
from pydantic import ValidationError
from app.capture_schemas import CaptureCreate, LandmarkBatch
from app.capture_storage import put_idempotent, convert_landmarks


def test_capture_requires_separate_consent():
    base = dict(patient_id=1, session_id=1, source_type='pre_recorded_video', record_landmarks=True, record_video=True, video_mime_type='video/mp4', started_at_utc='2026-01-01T00:00:00Z', start_performance_ms=10)
    with pytest.raises(ValidationError):
        CaptureCreate(**base)
    assert CaptureCreate(**base, consent_landmarks=True, consent_video=True).source_type == 'pre_recorded_video'


def test_batch_validation_and_idempotency(tmp_path):
    batch = LandmarkBatch(batch_index=0, frames=[dict(frame_id=0,timestamp_ms=10,video_media_time_ms=10,inference_performed=True,pose_detected=False,hand_detected=False,landmarks=[])])
    payload = batch.model_dump_json().encode()
    path = tmp_path / 'batch'
    assert put_idempotent(path, payload)
    assert not put_idempotent(path, payload)
    with pytest.raises(ValueError):
        put_idempotent(path, b'different')


def test_parquet_preserves_empty_frames_and_raw_invalid_landmarks(tmp_path):
    import json
    import pyarrow.parquet as pq
    frames = [dict(frame_id=0,timestamp_ms=0,video_media_time_ms=0,inference_performed=True,pose_detected=False,hand_detected=False,landmarks=[]),dict(frame_id=1,timestamp_ms=20,video_media_time_ms=20,inference_performed=True,pose_detected=True,hand_detected=False,landmarks=[dict(landmark_source='pose',landmark_index=0,landmark_name='nose',x=0.1,y=0.2,z=-0.3,coordinate_space='normalized_image',is_valid=False,invalid_reason='low_visibility')])]
    batch = LandmarkBatch(batch_index=0, frames=frames)
    (tmp_path / '0.json').write_text(batch.model_dump_json(), encoding='utf8')
    summary = convert_landmarks(tmp_path, [tmp_path / '0.json'], 'test-capture', 1, 2, 3)
    assert summary['frame_count'] == 2 and summary['landmark_count'] == 1
    f = pq.read_table(tmp_path / 'frames.parquet').to_pylist()
    l = pq.read_table(tmp_path / 'landmarks.parquet').to_pylist()
    assert f[0]['pose_detected'] is False and f[1]['video_media_time_ms'] == 20
    assert l[0]['is_valid'] is False and l[0]['invalid_reason'] == 'low_visibility'
    assert l[0]['capture_id'] == 'test-capture' and l[0]['x'] == 0.1
