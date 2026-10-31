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
    timestamp_ms: float = Field(ge=0)
    video_media_time_ms: float | None = Field(default=None, ge=0)
    utc_time: datetime | None = None
    inference_performed: bool
    pose_detected: bool | None = None
    hand_detected: bool | None = None
    inference_ms: float | None = Field(default=None, ge=0)
    skipped_frames: int = Field(default=0, ge=0)
    landmarks: list[Landmark] = Field(default_factory=list, max_length=1000)

    @model_validator(mode='after')
    def inference_consistency(self):
        if not self.inference_performed and (self.landmarks or self.pose_detected is not None or self.hand_detected is not None):
            raise ValueError('A frame without inference cannot have detection results')
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
    ended_at_utc: datetime
    duration_ms: float = Field(ge=0)

    @model_validator(mode='after')
    def aware_time(self):
        if self.ended_at_utc.utcoffset() is None:
            raise ValueError('ended_at_utc must include a timezone')
        return self
