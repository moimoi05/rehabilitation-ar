from datetime import datetime
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

class PatientUpdate(ORMModel):
    research_code: str | None = Field(default=None, min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    affected_side: Side | None = None
    dominant_hand: Side | None = None
    notes: str | None = Field(default=None, max_length=2000)

class PatientOut(PatientCreate):
    id: int
    created_at: datetime

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

class CalibrationOut(CalibrationCreate):
    id: int
    created_at: datetime


class ExerciseResultCreate(ORMModel):
    session_id: int = Field(gt=0, strict=True)
    round_id: UUID
    game_key: Literal['glowing_flower']
    source: Literal['camera']
    affected_side: Side
    duration_seconds: float = Field(gt=0, le=600, allow_inf_nan=False)
    score: int = Field(ge=0, le=10000, strict=True)
    target_count: int = Field(ge=0, le=10000, strict=True)

    @model_validator(mode='after')
    def valid_score(self):
        if self.score > self.target_count:
            raise ValueError('Số lần chạm không được vượt số mục tiêu')
        return self


class ExerciseResultOut(ExerciseResultCreate):
    id: int
    trial_id: int
    created_at: datetime
