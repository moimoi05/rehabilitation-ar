from datetime import datetime
from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Timestamped:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

class Patient(Timestamped, Base):
    __tablename__ = 'patients'
    id: Mapped[int] = mapped_column(primary_key=True)
    research_code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    affected_side: Mapped[str] = mapped_column(String(5))
    dominant_hand: Mapped[str] = mapped_column(String(5))
    notes: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (CheckConstraint("affected_side IN ('left','right')"), CheckConstraint("dominant_hand IN ('left','right')"))

class Session(Timestamped, Base):
    __tablename__ = 'sessions'
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id', ondelete='RESTRICT'), index=True)
    affected_side: Mapped[str] = mapped_column(String(5))
    session_type: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default='draft', index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (CheckConstraint("affected_side IN ('left','right')"), CheckConstraint("session_type IN ('assessment','training')"), CheckConstraint("status IN ('draft','in_progress','completed','cancelled')"), CheckConstraint('ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at'))

class Calibration(Timestamped, Base):
    __tablename__ = 'calibrations'
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), index=True)
    camera_label: Mapped[str | None] = mapped_column(String(255))
    camera_device_id: Mapped[str | None] = mapped_column(String(512))
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    mirrored: Mapped[bool] = mapped_column(Boolean)
    ghost_visible: Mapped[bool] = mapped_column(Boolean)
    opacity: Mapped[float] = mapped_column(Float)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    scale: Mapped[float] = mapped_column(Float)
    image_anchor: Mapped[dict | None] = mapped_column(JSON(none_as_null=True), nullable=True)
    affected_side: Mapped[str] = mapped_column(String(5))
    confirmed: Mapped[bool] = mapped_column(Boolean)
    __table_args__ = (CheckConstraint('opacity >= 0 AND opacity <= 1'), CheckConstraint('x >= 0 AND x <= 1'), CheckConstraint('y >= 0 AND y <= 1'), CheckConstraint('scale >= 0.2 AND scale <= 3'), CheckConstraint("affected_side IN ('left','right')"))

class ClinicalAssessment(Timestamped, Base):
    __tablename__ = 'clinical_assessments'
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id', ondelete='RESTRICT'), index=True)
    fma_ue_score: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (CheckConstraint('fma_ue_score IS NULL OR (fma_ue_score >= 0 AND fma_ue_score <= 66)'),)

class Trial(Timestamped, Base):
    __tablename__ = 'trials'
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), index=True)
    exercise_code: Mapped[str] = mapped_column(String(64))
    notes: Mapped[str | None] = mapped_column(Text)

class LandmarkRecord(Timestamped, Base):
    __tablename__ = 'landmark_records'
    id: Mapped[int] = mapped_column(primary_key=True)
    trial_id: Mapped[int] = mapped_column(ForeignKey('trials.id', ondelete='RESTRICT'), index=True)
    storage_reference: Mapped[str] = mapped_column(String(1024))
    format: Mapped[str] = mapped_column(String(32))
    model_version: Mapped[str | None] = mapped_column(String(128))

class VideoRecord(Timestamped, Base):
    __tablename__ = 'video_records'
    id: Mapped[int] = mapped_column(primary_key=True)
    trial_id: Mapped[int] = mapped_column(ForeignKey('trials.id', ondelete='RESTRICT'), index=True)
    storage_reference: Mapped[str] = mapped_column(String(1024))
    consent_recorded: Mapped[bool] = mapped_column(Boolean, default=False)

class ExerciseResult(Timestamped, Base):
    __tablename__ = 'exercise_results'
    id: Mapped[int] = mapped_column(primary_key=True)
    trial_id: Mapped[int] = mapped_column(ForeignKey('trials.id', ondelete='RESTRICT'), index=True)
    result_json: Mapped[str] = mapped_column(Text)
    # Existing historical results may not have a round ID. New game rounds do.
    round_id: Mapped[str | None] = mapped_column(String(36), unique=True)

class ModelPrediction(Timestamped, Base):
    __tablename__ = 'model_predictions'
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), index=True)
    model_version: Mapped[str] = mapped_column(String(128))
    prediction_json: Mapped[str] = mapped_column(Text)
    clinician_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)

class AuditLog(Timestamped, Base):
    __tablename__ = 'audit_logs'
    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[int] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(32))
    detail: Mapped[str | None] = mapped_column(Text)
