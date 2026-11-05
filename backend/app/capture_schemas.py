from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)

class CaptureCreate(StrictModel):
    patient_id: int = Field(gt=0)
    session_id: int = Field(gt=0)
    trial_id: int | None = Field(default=None, gt=0)
    exercise_code: str = Field(default='tracking_test', min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    source_type: Literal['webcam', 'pre_recorded_video']
    record_landmarks: bool
    record_video: bool
    consent_landmarks: bool = False
    consent_video: bool = False
    started_at_utc: datetime
    start_performance_ms: float = Field(ge=0)
    video_mime_type: str | None = Field(default=None, max_length=128)
    width: int | None = Field(default=None, ge=1, le=16384)
    height: int | None = Field(default=None, ge=1, le=16384)
    model_config_info: dict = Field(default_factory=dict, alias='model_config')
    capture_mode: Literal['manual', 'per_trial'] = 'manual'
    capture_schema_version: Literal[2] = 2

    @model_validator(mode='after')
    def check_consent(self):
        if not self.record_landmarks and not self.record_video:
            raise ValueError('Select at least one artifact')
        if (self.record_landmarks and not self.consent_landmarks) or (self.record_video and not self.consent_video):
            raise ValueError('Separate consent is required for each artifact')
        if self.started_at_utc.utcoffset() is None:
            raise ValueError('started_at_utc must include a timezone')
        if self.record_video and (not self.video_mime_type or self.video_mime_type.split(';')[0].strip().lower() not in ('video/webm', 'video/mp4', 'video/ogg')):
            raise ValueError('Unsupported video MIME type')
        if 'recorder_start' in self.model_config_info:
            raise ValueError('recorder_start is server-managed metadata')
        if 'tracking_recorder_start' in self.model_config_info:
            raise ValueError('tracking_recorder_start is server-managed metadata')
        tracking = self.model_config_info.get('record_tracking_video', False)
        if type(tracking) is not bool:
            raise ValueError('record_tracking_video must be a boolean')
        if tracking and (not self.record_video or not self.record_landmarks):
            raise ValueError('Tracking video requires consent for video and landmarks')
        if self.capture_mode == 'per_trial' and (self.trial_id is None or not self.record_landmarks or not self.record_video):
            raise ValueError('Automatic per-trial capture requires an existing trial, video and landmarks')
        return self


class RecorderStart(StrictModel):
    start_performance_ms: float = Field(ge=0)
    started_at_utc: datetime
    mime_type: str = Field(min_length=1, max_length=128)

    @model_validator(mode='after')
    def aware_time_and_mime(self):
        if self.started_at_utc.utcoffset() is None:
            raise ValueError('started_at_utc must include a timezone')
        if self.mime_type.split(';')[0].strip().lower() not in ('video/webm', 'video/mp4', 'video/ogg'):
            raise ValueError('Unsupported video MIME type')
        return self

class Landmark(StrictModel):
    landmark_source: Literal['pose', 'hand']
    landmark_index: int = Field(ge=0, le=1000)
    landmark_name: str = Field(min_length=1, max_length=128)
    x: float | None = None
    y: float | None = None
    z: float | None = None
    coordinate_space: Literal['normalized_image', 'world']
    is_valid: bool
    invalid_reason: str | None = Field(default=None, max_length=256)
    visibility: float | None = None
    presence: float | None = None
    handedness: str | None = Field(default=None, max_length=32)
    handedness_score: float | None = Field(default=None, ge=0, le=1)
    hand_observation_index: int | None = Field(default=None, ge=0, le=100)
    representation: Literal['raw', 'display'] = 'raw'

    @model_validator(mode='after')
    def valid_details(self):
        if self.is_valid and (self.x is None or self.y is None or self.z is None):
            raise ValueError('Valid landmarks require x, y and z')
        if not self.is_valid and not self.invalid_reason:
            raise ValueError('Invalid landmarks require a reason')
        return self

class Frame(StrictModel):
    frame_id: int = Field(ge=0)
    source_frame_id: int | None = Field(default=None, ge=0)
    source_observation_id: int | None = Field(default=None, ge=0)
    timestamp_ms: float = Field(ge=0)
    video_media_time_ms: float | None = Field(default=None, ge=0)
    utc_time: datetime | None = None
    inference_performed: bool
    pose_detected: bool | None = None
    hand_detected: bool | None = None
    inference_ms: float | None = Field(default=None, ge=0)
    pose_inference_performed: bool | None = None
    hand_inference_performed: bool | None = None
    pose_inference_ms: float | None = Field(default=None, ge=0)
    hand_inference_ms: float | None = Field(default=None, ge=0)
    pose_inference_status: Literal['not_run', 'detected', 'not_detected', 'error', 'missing_result'] | None = None
    hand_inference_status: Literal['not_run', 'detected', 'not_detected', 'error', 'missing_result'] | None = None
    pose_error: str | None = Field(default=None, max_length=1000)
    hand_error: str | None = Field(default=None, max_length=1000)
    skipped_frames: int = Field(default=0, ge=0)
    landmarks: list[Landmark] = Field(default_factory=list, max_length=1000)

    @model_validator(mode='after')
    def inference_consistency(self):
        if not self.inference_performed and (self.landmarks or self.pose_detected is not None or self.hand_detected is not None):
            raise ValueError('A frame without inference cannot have detection results')
        performed = [self.pose_inference_performed, self.hand_inference_performed]
        if all(value is not None for value in performed) and self.inference_performed != any(performed):
            raise ValueError('inference_performed must equal Pose OR Hand inference in schema 2')
        for model in ('pose', 'hand'):
            ran = getattr(self, f'{model}_inference_performed')
            status = getattr(self, f'{model}_inference_status')
            detected = getattr(self, f'{model}_detected')
            if status is None:
                continue  # Legacy data cannot tell which model actually ran.
            if (status == 'not_run' and ran is not False) or (status in ('detected', 'not_detected') and ran is not True):
                raise ValueError('Per-model inference status and performed flag disagree')
            expected = True if status == 'detected' else False if status == 'not_detected' else None
            if detected is not expected:
                raise ValueError('Per-model detection must distinguish missing/error from no detection')
            if status != 'detected' and any(point.landmark_source == model for point in self.landmarks):
                raise ValueError('Landmarks require a detected result from their model')
        return self

class LandmarkBatch(StrictModel):
    batch_index: int = Field(ge=0, le=1000000)
    frames: list[Frame] = Field(min_length=1, max_length=128)

    @model_validator(mode='after')
    def ordered_frames(self):
        if any(a.frame_id >= b.frame_id or a.timestamp_ms > b.timestamp_ms for a,b in zip(self.frames, self.frames[1:])):
            raise ValueError('Frames must be in ascending order')
        return self

class CaptureFinalize(StrictModel):
    expected_batches: int = Field(ge=0, le=1000000)
    expected_video_chunks: int = Field(ge=0, le=1000000)
    expected_tracking_video_chunks: int = Field(default=0, ge=0, le=1000000)
    tracking_video_complete: bool = True
    ended_at_utc: datetime
    duration_ms: float = Field(ge=0)
    game_started_at_ms: float | None = Field(default=None, ge=0)
    game_ended_at_ms: float | None = Field(default=None, ge=0)
    termination_reason: str | None = Field(default=None, min_length=1, max_length=256)
    known_data_gaps: list[str] = Field(default_factory=list, max_length=128)

    @model_validator(mode='after')
    def aware_time(self):
        if self.ended_at_utc.utcoffset() is None:
            raise ValueError('ended_at_utc must include a timezone')
        if any(not gap or len(gap) > 1000 for gap in self.known_data_gaps):
            raise ValueError('Data gap descriptions must contain 1 to 1000 characters')
        if self.game_ended_at_ms is not None and (self.game_started_at_ms is None or self.game_ended_at_ms < self.game_started_at_ms or self.game_ended_at_ms > self.duration_ms):
            raise ValueError('Gameplay times must be ordered within capture duration')
        return self


class CaptureIncomplete(StrictModel):
    reason: str = Field(min_length=1, max_length=1000)
    known_data_gaps: list[str] = Field(default_factory=list, max_length=128)

    @model_validator(mode='after')
    def bounded_gaps(self):
        if any(not gap or len(gap) > 1000 for gap in self.known_data_gaps):
            raise ValueError('Data gap descriptions must contain 1 to 1000 characters')
        return self
