"""Validated contracts for domain workflows; legacy wire contracts remain usable."""
from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, field_validator, model_validator

from .schemas import ORMModel

PatientType = Literal['outpatient', 'inpatient']
QuestionType = Literal['text', 'number', 'date', 'single_choice', 'multiple_choice', 'boolean']


class TransferCreate(ORMModel):
    to_type: PatientType
    baseline_assessment_session_id: int | None = Field(default=None, gt=0)
    admitted_at: AwareDatetime | None = None
    reason: str | None = Field(default=None, max_length=2000)
    allow_without_baseline: bool = False

    @field_validator('reason')
    @classmethod
    def trim_reason(cls, value):
        return value.strip() if value is not None else None


class DomainSessionCreate(ORMModel):
    patient_id: int = Field(gt=0, strict=True)
    notes: str | None = Field(default=None, max_length=2000)


class AssessmentUpdate(ORMModel):
    notes: str | None = Field(default=None, max_length=2000)
    selected_exercise_ids: list[int] | None = Field(default=None, max_length=100)
    fma_ue_score: int | None = Field(default=None, ge=0, le=66, strict=True)
    clinician_name: str | None = Field(default=None, min_length=1, max_length=255)
    clinician_confirmed: bool = False

    @field_validator('selected_exercise_ids')
    @classmethod
    def unique_exercises(cls, value):
        if value is not None and (any(type(i) is not int or i <= 0 for i in value) or len(value) != len(set(value))):
            raise ValueError('Danh sách bài phải có mã hợp lệ và không trùng')
        return value

    @model_validator(mode='after')
    def clinician_confirmation(self):
        if self.fma_ue_score is not None and (not self.clinician_confirmed or not self.clinician_name or not self.clinician_name.strip()):
            raise ValueError('Điểm FMA-UE cần người chuyên môn nhập tên và xác nhận')
        return self


class TrialCreate(ORMModel):
    session_id: int = Field(gt=0, strict=True)
    exercise_id: int = Field(gt=0, strict=True)
    client_round_id: UUID | None = None


class TrialOut(ORMModel):
    id: int
    session_id: int
    exercise_id: int | None
    exercise_code: str
    trial_number: int | None
    client_round_id: str | None = None
    started_at: datetime | None
    ended_at: datetime | None
    status: str | None
    notes: str | None = None
    created_at: datetime


class QuestionCreate(ORMModel):
    key: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    label: str = Field(min_length=1, max_length=1000)
    group: str = Field(default='Thông tin lâm sàng', min_length=1, max_length=255)
    question_type: QuestionType
    required: bool = False
    display_order: int = Field(ge=0, strict=True)
    options: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode='after')
    def valid_options(self):
        if self.question_type in ('single_choice', 'multiple_choice') and not self.options:
            raise ValueError('Câu hỏi lựa chọn cần danh sách đáp án')
        if any(not v.strip() or len(v) > 500 for v in self.options) or len(self.options) != len(set(self.options)):
            raise ValueError('Đáp án không hợp lệ hoặc bị trùng')
        return self


class TemplateCreate(ORMModel):
    code: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    name: str = Field(min_length=1, max_length=255)
    version: int = Field(gt=0, strict=True)
    active: bool = True
    questions: list[QuestionCreate] = Field(min_length=1, max_length=100)

    @model_validator(mode='after')
    def unique_keys(self):
        if len({q.key for q in self.questions}) != len(self.questions):
            raise ValueError('Mã câu hỏi không được trùng')
        return self


class SubmissionCreate(ORMModel):
    session_id: int = Field(gt=0, strict=True)
    template_id: int = Field(gt=0, strict=True)


class AnswerCreate(ORMModel):
    question_key: str = Field(min_length=1, max_length=64)
    value: Any


class AnswersCreate(ORMModel):
    answers: list[AnswerCreate] = Field(max_length=100)
    complete: bool = False

    @model_validator(mode='after')
    def unique_keys(self):
        if len({a.question_key for a in self.answers}) != len(self.answers):
            raise ValueError('Không gửi trùng câu trả lời')
        return self


class PrescriptionCreate(ORMModel):
    exercise_id: int = Field(gt=0, strict=True)
    clinician_name: str = Field(min_length=1, max_length=255)
    notes: str | None = Field(default=None, max_length=2000)
    starts_on: date | None = None
    ends_on: date | None = None

    @model_validator(mode='after')
    def valid_dates(self):
        if self.starts_on and self.ends_on and self.ends_on < self.starts_on:
            raise ValueError('Ngày kết thúc phải sau ngày bắt đầu')
        if not self.clinician_name.strip():
            raise ValueError('Cần tên người chỉ định')
        return self


class PrescriptionUpdate(ORMModel):
    active: bool | None = None
    clinician_name: str | None = Field(default=None, min_length=1, max_length=255)
    notes: str | None = Field(default=None, max_length=2000)
    starts_on: date | None = None
    ends_on: date | None = None
