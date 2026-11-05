from datetime import datetime
import json
import math
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
    capture_schema_version: Literal[2, 3] = 2

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
        if self.capture_schema_version == 3 and self.capture_mode != 'per_trial':
            raise ValueError('Capture schema 3 requires automatic per-trial capture')
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
    expected_game_batches: int = Field(default=0, ge=0, le=1000000)
    game_data_complete: bool = True
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


class GameRecord(StrictModel):
    capture_id: str = Field(min_length=36, max_length=36, pattern=r'^[0-9a-fA-F-]+$')
    trial_id: int = Field(gt=0)
    game_key: Literal['glowing_flower', 'free_drawing']
    sequence: int = Field(ge=0)
    timestamp_ms: float = Field(ge=0)
    source_timestamp_ms: float | None = Field(default=None, ge=0)
    source_observation_id: int | None = Field(default=None, ge=0)
    frame_id: int | None = Field(default=None, ge=0)
    payload: dict = Field(default_factory=dict, max_length=256)

    @model_validator(mode='after')
    def bounded_payload(self):
        def validate(value, depth=0):
            if depth > 8:
                raise ValueError('Game payload nesting is too deep')
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError('Game payload numbers must be finite')
            if isinstance(value, dict):
                if any(not isinstance(key, str) for key in value):
                    raise ValueError('Game payload keys must be strings')
                for item in value.values():
                    validate(item, depth + 1)
            elif isinstance(value, list):
                if len(value) > 1024:
                    raise ValueError('Game payload array is too large')
                for item in value:
                    validate(item, depth + 1)
            elif value is not None and not isinstance(value, (str, int, float, bool)):
                raise ValueError('Game payload must contain JSON values')
        validate(self.payload)
        if len(json.dumps(self.payload, ensure_ascii=False, allow_nan=False).encode('utf-8')) > 65536:
            raise ValueError('Game payload is too large')
        return self


class GameEvent(GameRecord):
    event_id: str = Field(min_length=1, max_length=160)
    event_schema_version: Literal[1] = 1
    event_type: str = Field(min_length=1, max_length=64, pattern=r'^[A-Z][A-Z0-9_]+$')


class InteractionSample(GameRecord):
    sample_id: str = Field(min_length=1, max_length=160)
    sample_schema_version: Literal[1] = 1
    sample_type: Literal['flower_cursor', 'drawing_stroke_point', 'drawing_drag_point', 'hand_features']

    @model_validator(mode='after')
    def valid_game_sample(self):
        if (self.sample_type == 'flower_cursor') != (self.game_key == 'glowing_flower'):
            raise ValueError('Sample type does not match game')
        if self.sample_type == 'hand_features':
            return self
        def finite_number(value):
            try:
                return type(value) in (int, float) and math.isfinite(value)
            except OverflowError:
                return False
        for dimension in ('width', 'height'):
            if not finite_number(self.payload.get(dimension)) or self.payload[dimension] <= 0:
                raise ValueError('Game samples require positive coordinate dimensions')
        if self.payload.get('coordinate_space') not in ('display_normalized', 'display_pixels', 'logical_canvas_px'):
            raise ValueError('Game sample coordinate space is unsupported')
        usable = self.payload.get('usable', True)
        if type(usable) is not bool:
            raise ValueError('Sample usable must be a boolean')
        if usable and any(not finite_number(self.payload.get(axis)) for axis in ('x', 'y')):
            raise ValueError('Usable game samples require finite processed coordinates')
        entity_key = 'target_id' if self.sample_type == 'flower_cursor' else 'stroke_id'
        if type(self.payload.get(entity_key)) not in (str, int) or str(self.payload[entity_key]) == '':
            raise ValueError('Game sample must identify its target or stroke')
        if self.sample_type == 'drawing_drag_point' and type(self.payload.get('drag_id')) not in (str, int):
            raise ValueError('Drag sample must identify its grab operation')
        return self


class GameBatch(StrictModel):
    batch_index: int = Field(ge=0, le=1000000)
    events: list[GameEvent] = Field(default_factory=list, max_length=256)
    samples: list[InteractionSample] = Field(default_factory=list, max_length=512)

    @model_validator(mode='after')
    def ordered_records(self):
        if not self.events and not self.samples:
            raise ValueError('Game batch must contain records')
        for records in (self.events, self.samples):
            if any(a.sequence >= b.sequence or a.timestamp_ms > b.timestamp_ms for a, b in zip(records, records[1:])):
                raise ValueError('Game records must be in sequence and timestamp order')
        return self
