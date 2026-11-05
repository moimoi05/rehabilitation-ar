from datetime import date, datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Side = Literal['left', 'right']
Status = Literal['draft', 'in_progress', 'completed', 'cancelled']

class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra='forbid')

class PatientCreate(ORMModel):
    research_code: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    affected_side: Side
    dominant_hand: Side
    notes: str | None = Field(default=None, max_length=2000)
    patient_type: Literal['outpatient', 'inpatient'] = 'outpatient'
    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    date_of_birth: date | None = None
    sex: Literal['male', 'female', 'other', 'unspecified'] | None = None
    contact: str | None = Field(default=None, max_length=512)

    @field_validator('date_of_birth')
    @classmethod
    def past_birth_date(cls, value):
        from .workflow_common import hospital_timezone
        if value is not None and value > datetime.now(hospital_timezone()).date():
            raise ValueError('Ngày sinh không được ở tương lai')
        return value

class PatientUpdate(ORMModel):
    research_code: str | None = Field(default=None, min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    affected_side: Side | None = None
    dominant_hand: Side | None = None
    notes: str | None = Field(default=None, max_length=2000)
    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    date_of_birth: date | None = None
    sex: Literal['male', 'female', 'other', 'unspecified'] | None = None
    contact: str | None = Field(default=None, max_length=512)
    legacy_review_required: bool | None = None

    _past_birth_date = field_validator('date_of_birth')(PatientCreate.past_birth_date.__func__)

class PatientOut(PatientCreate):
    id: int
    created_at: datetime
    admitted_at: datetime | None = None
    legacy_review_required: bool = False

class SessionCreate(ORMModel):
    patient_id: int = Field(gt=0)
    affected_side: Side
    session_type: Literal['assessment', 'training']
    status: Status = 'draft'
    started_at: datetime | None = None
    ended_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode='after')
    def valid_times(self):
        if self.started_at and self.ended_at:
            try:
                if self.ended_at < self.started_at:
                    raise ValueError('ended_at phải sau started_at')
            except TypeError as exc:
                raise ValueError('Thời gian cần cùng múi giờ') from exc
        return self

class SessionUpdate(ORMModel):
    affected_side: Side | None = None
    session_type: Literal['assessment', 'training'] | None = None
    status: Status | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=2000)

class SessionOut(SessionCreate):
    id: int
    created_at: datetime
    managed_workflow: bool = False
    setup_confirmed: bool = False
    setup_revision: int = 0

class ImageAnchor(ORMModel):
    """Version 1 uses source-image coordinates before mirroring."""
    version: Literal[1]
    x: float = Field(ge=0, le=1, allow_inf_nan=False, strict=True)
    y: float = Field(ge=0, le=1, allow_inf_nan=False, strict=True)
    scale: float = Field(gt=0, le=15, allow_inf_nan=False, strict=True)

    @field_validator('version', mode='before')
    @classmethod
    def version_is_integer(cls, value):
        if type(value) is not int:
            raise ValueError('Anchor version must be an integer')
        return value


class CalibrationCreate(ORMModel):
    session_id: int = Field(gt=0)
    camera_label: str | None = Field(default=None, max_length=255)
    camera_device_id: str | None = Field(default=None, max_length=512)
    width: int | None = Field(default=None, ge=1, le=7680)
    height: int | None = Field(default=None, ge=1, le=4320)
    mirrored: bool = True
    ghost_visible: bool = True
    opacity: float = Field(default=.45, ge=0, le=1, allow_inf_nan=False)
    x: float = Field(default=.5, ge=0, le=1, allow_inf_nan=False)
    y: float = Field(default=.5, ge=0, le=1, allow_inf_nan=False)
    scale: float = Field(default=1, ge=.2, le=3, allow_inf_nan=False)
    image_anchor: ImageAnchor | None = None
    affected_side: Side
    confirmed: bool = False
    setup_revision: int | None = Field(default=None, ge=0, strict=True)

class CalibrationOut(CalibrationCreate):
    id: int
    created_at: datetime


class ExerciseResultCreate(ORMModel):
    session_id: int = Field(gt=0, strict=True)
    round_id: UUID
    game_key: Literal['glowing_flower', 'free_drawing']
    source: Literal['camera']
    affected_side: Side
    duration_seconds: float = Field(gt=0, allow_inf_nan=False)
    score: int | None = Field(default=None, ge=0, le=10000, strict=True)
    target_count: int | None = Field(default=None, ge=0, le=10000, strict=True)
    completed_strokes: int | None = Field(default=None, ge=0, le=10000, strict=True)
    active_drawing_seconds: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    trial_id: int | None = Field(default=None, gt=0, strict=True)

    @model_validator(mode='after')
    def valid_score(self):
        if self.game_key == 'glowing_flower':
            if self.duration_seconds > 600:
                raise ValueError('Thời lượng Hái hoa không được vượt 600 giây')
            if self.score is None or self.target_count is None:
                raise ValueError('Hái hoa cần số lần chạm và số mục tiêu')
            if self.score > self.target_count:
                raise ValueError('Số lần chạm không được vượt số mục tiêu')
            if self.completed_strokes is not None or self.active_drawing_seconds is not None:
                raise ValueError('Hái hoa không nhận dữ liệu nét vẽ')
        else:
            if self.score is not None or self.target_count is not None:
                raise ValueError('Vẽ tự do không có điểm hay số mục tiêu')
            if self.completed_strokes is None:
                raise ValueError('Vẽ tự do cần số nét đã hoàn tất')
            if self.active_drawing_seconds is not None and self.active_drawing_seconds > self.duration_seconds:
                raise ValueError('Thời gian vẽ không được vượt thời lượng hoạt động')
        return self


class ExerciseResultOut(ExerciseResultCreate):
    id: int
    trial_id: int
    created_at: datetime
    exercise_id: int | None = None
    exercise_code: str | None = None
