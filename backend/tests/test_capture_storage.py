import pytest
from pydantic import ValidationError
from app.capture_schemas import CaptureCreate, LandmarkBatch
from app.capture_storage import put_idempotent, convert_landmarks


def test_capture_requires_separate_consent():
    base = dict(patient_id=1, session_id=1, source_type='pre_recorded_video', record_landmarks=True, record_video=True, video_mime_type='video/mp4', started_at_utc='2026-01-01T00:00:00Z', start_performance_ms=10)
    with pytest.raises(ValidationError):
        CaptureCreate(**base)
    assert CaptureCreate(**base, consent_landmarks=True, consent_video=True).source_type == 'pre_recorded_video'


def test_tracking_video_requires_both_recording_permissions():
    base = dict(patient_id=1, session_id=1, source_type='webcam', record_landmarks=True,
        record_video=True, video_mime_type='video/webm', started_at_utc='2026-01-01T00:00:00Z',
        start_performance_ms=10, consent_landmarks=True, consent_video=True,
        model_config={'record_tracking_video': True})
    assert CaptureCreate(**base).model_config_info['record_tracking_video'] is True
    for changes in ({'record_landmarks': False}, {'record_video': False}, {'consent_video': False},
                    {'consent_landmarks': False}, {'model_config': {'record_tracking_video': 'true'}},
                    {'model_config': {'tracking_recorder_start': {}}}):
        with pytest.raises(ValidationError):
            CaptureCreate(**{**base, **changes})


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


def test_phase1_parquet_preserves_independent_model_states_and_hand_identity(tmp_path):
    import pyarrow.parquet as pq
    frame = dict(frame_id=0, source_observation_id=17, timestamp_ms=25,
                 inference_performed=True, pose_inference_performed=True,
                 hand_inference_performed=True, pose_inference_status='missing_result',
                 hand_inference_status='detected', pose_detected=None, hand_detected=True,
                 pose_inference_ms=None, hand_inference_ms=4.5, pose_error='result timeout',
                 landmarks=[dict(landmark_source='hand', landmark_index=0,
                    landmark_name='wrist', x=.1, y=.2, z=.3,
                    coordinate_space='world', is_valid=True, representation='raw',
                    handedness='Left', handedness_score=.93, hand_observation_index=1)])
    batch = LandmarkBatch(batch_index=0, frames=[frame])
    staged = tmp_path / '0.json'
    staged.write_text(batch.model_dump_json(), encoding='utf-8')
    summary = convert_landmarks(tmp_path, [staged], 'capture', 1, 2, 3)
    recorded_frame = pq.read_table(tmp_path / 'frames.parquet').to_pylist()[0]
    point = pq.read_table(tmp_path / 'landmarks.parquet').to_pylist()[0]
    assert recorded_frame['source_observation_id'] == 17
    assert recorded_frame['pose_inference_status'] == 'missing_result'
    assert recorded_frame['pose_detected'] is None
    assert recorded_frame['hand_inference_ms'] == 4.5
    assert point['handedness_score'] == .93 and point['hand_observation_index'] == 1
    assert summary['last_timestamp_ms'] == 25
    assert summary['model_status_counts'] == {'pose': {'missing_result': 1}, 'hand': {'detected': 1}}
    assert summary['missing_result_summary']['pose']['count'] == 1


def test_phase1_rejects_contradictory_per_model_states():
    with pytest.raises(ValidationError):
        LandmarkBatch(batch_index=0, frames=[dict(frame_id=0, timestamp_ms=0,
            inference_performed=True, pose_inference_performed=False,
            pose_inference_status='detected', pose_detected=True)])
