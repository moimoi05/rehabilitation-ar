from datetime import date, datetime
from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint, func, text
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
    patient_type: Mapped[str] = mapped_column(String(16), default='outpatient', server_default='outpatient', index=True)
    full_name: Mapped[str | None] = mapped_column(String(255))
    date_of_birth: Mapped[date | None] = mapped_column(Date)
    sex: Mapped[str | None] = mapped_column(String(16))
    contact: Mapped[str | None] = mapped_column(String(512))
    admitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    legacy_review_required: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text('false'))
    __table_args__ = (CheckConstraint("affected_side IN ('left','right')"), CheckConstraint("dominant_hand IN ('left','right')"),
        CheckConstraint("patient_type IN ('outpatient','inpatient')", name='ck_patient_type'),
        CheckConstraint("sex IS NULL OR sex IN ('male','female','other','unspecified')", name='ck_patient_sex'))

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
    managed_workflow: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text('false'))
    setup_confirmed: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text('false'))
    setup_revision: Mapped[int] = mapped_column(Integer, default=0, server_default=text('0'))
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
    session_id: Mapped[int | None] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), index=True)
    fma_ue_score: Mapped[int | None] = mapped_column(Integer)
    clinician_name: Mapped[str | None] = mapped_column(String(255))
    clinician_confirmed: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text('false'))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (CheckConstraint('fma_ue_score IS NULL OR (fma_ue_score >= 0 AND fma_ue_score <= 66)'),)

class Trial(Timestamped, Base):
    __tablename__ = 'trials'
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), index=True)
    exercise_code: Mapped[str] = mapped_column(String(64))
    exercise_id: Mapped[int | None] = mapped_column(ForeignKey('exercise_catalog.id', ondelete='RESTRICT'), index=True)
    client_round_id: Mapped[str | None] = mapped_column(String(36), unique=True)
    trial_number: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str | None] = mapped_column(String(16))
    notes: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (UniqueConstraint('session_id', 'trial_number', name='uq_trial_session_number'),
        CheckConstraint("status IS NULL OR status IN ('in_progress','completed','cancelled')", name='ck_trial_status'),
        CheckConstraint('trial_number IS NULL OR trial_number > 0', name='ck_trial_number'),
        CheckConstraint('ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at', name='ck_trial_times'))

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

class CaptureRun(Timestamped, Base):
    __tablename__ = 'capture_runs'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id', ondelete='RESTRICT'), index=True)
    session_id: Mapped[int] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), index=True)
    trial_id: Mapped[int] = mapped_column(ForeignKey('trials.id', ondelete='RESTRICT'), index=True)
    source_type: Mapped[str] = mapped_column(String(32))
    capture_mode: Mapped[str] = mapped_column(String(16), default='manual', server_default=text("'manual'"))
    capture_schema_version: Mapped[int] = mapped_column(Integer, default=2, server_default=text('1'))
    status: Mapped[str] = mapped_column(String(20), default='recording', index=True)
    record_landmarks: Mapped[bool] = mapped_column(Boolean)
    record_video: Mapped[bool] = mapped_column(Boolean)
    consent_landmarks: Mapped[bool] = mapped_column(Boolean)
    consent_video: Mapped[bool] = mapped_column(Boolean)
    started_at_utc: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at_utc: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    start_performance_ms: Mapped[float] = mapped_column(Float)
    duration_ms: Mapped[float | None] = mapped_column(Float)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    video_mime_type: Mapped[str | None] = mapped_column(String(128))
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    model_config_info: Mapped[dict] = mapped_column(JSON)
    artifact_summary: Mapped[dict | None] = mapped_column(JSON)
    error_message: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (CheckConstraint("source_type IN ('webcam','pre_recorded_video')"), CheckConstraint("status IN ('recording','complete','incomplete','aborted')"),
        CheckConstraint("capture_mode IN ('manual','per_trial')", name='ck_capture_mode'),
        Index('uq_capture_auto_trial', 'trial_id', unique=True, postgresql_where=text("capture_mode = 'per_trial'")))


class PatientTransfer(Timestamped, Base):
    __tablename__ = 'patient_transfers'
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id', ondelete='RESTRICT'), index=True)
    from_type: Mapped[str] = mapped_column(String(16))
    to_type: Mapped[str] = mapped_column(String(16))
    baseline_assessment_session_id: Mapped[int | None] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), index=True)
    admitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (CheckConstraint("from_type IN ('outpatient','inpatient') AND to_type IN ('outpatient','inpatient') AND from_type <> to_type", name='ck_transfer_types'),)


class QuestionnaireTemplate(Timestamped, Base):
    __tablename__ = 'questionnaire_templates'
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255))
    version: Mapped[int] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    __table_args__ = (UniqueConstraint('code', 'version', name='uq_questionnaire_version'),
        CheckConstraint('version > 0', name='ck_questionnaire_version'))


class QuestionnaireQuestion(Base):
    __tablename__ = 'questionnaire_questions'
    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(ForeignKey('questionnaire_templates.id', ondelete='RESTRICT'), index=True)
    key: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(1000))
    group: Mapped[str] = mapped_column(String(255))
    question_type: Mapped[str] = mapped_column(String(32))
    required: Mapped[bool] = mapped_column(Boolean)
    display_order: Mapped[int] = mapped_column(Integer)
    options: Mapped[list] = mapped_column(JSON)
    __table_args__ = (UniqueConstraint('template_id', 'key', name='uq_questionnaire_question_key'),
        CheckConstraint("question_type IN ('text','number','date','single_choice','multiple_choice','boolean')", name='ck_question_type'),
        CheckConstraint('display_order >= 0', name='ck_question_order'))


class QuestionnaireSubmission(Timestamped, Base):
    __tablename__ = 'questionnaire_submissions'
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), index=True)
    template_id: Mapped[int] = mapped_column(ForeignKey('questionnaire_templates.id', ondelete='RESTRICT'), index=True)
    template_snapshot: Mapped[dict] = mapped_column(JSON)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    __table_args__ = (UniqueConstraint('session_id', 'template_id', name='uq_submission_session_template'),)


class QuestionnaireAnswer(Timestamped, Base):
    __tablename__ = 'questionnaire_answers'
    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey('questionnaire_submissions.id', ondelete='RESTRICT'), index=True)
    question_key: Mapped[str] = mapped_column(String(64))
    value: Mapped[object] = mapped_column(JSON)
    __table_args__ = (UniqueConstraint('submission_id', 'question_key', name='uq_answer_submission_key'),)


class ExerciseCatalog(Timestamped, Base):
    __tablename__ = 'exercise_catalog'
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text)
    instructions: Mapped[str] = mapped_column(Text)
    exercise_type: Mapped[str] = mapped_column(String(32))
    usage_mode: Mapped[str] = mapped_column(String(16), index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    renderer: Mapped[str] = mapped_column(String(32))
    default_duration_seconds: Mapped[int] = mapped_column(Integer)
    __table_args__ = (CheckConstraint("usage_mode IN ('assessment','training','both')", name='ck_exercise_usage'),
        CheckConstraint('default_duration_seconds > 0 AND default_duration_seconds <= 600', name='ck_exercise_duration'))


class ExercisePrescription(Timestamped, Base):
    __tablename__ = 'exercise_prescriptions'
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id', ondelete='RESTRICT'), index=True)
    exercise_id: Mapped[int] = mapped_column(ForeignKey('exercise_catalog.id', ondelete='RESTRICT'), index=True)
    clinician_name: Mapped[str] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    starts_on: Mapped[date | None] = mapped_column(Date)
    ends_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (CheckConstraint('ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on', name='ck_prescription_dates'),)


class SessionExercise(Base):
    __tablename__ = 'session_exercises'
    session_id: Mapped[int] = mapped_column(ForeignKey('sessions.id', ondelete='RESTRICT'), primary_key=True)
    exercise_id: Mapped[int] = mapped_column(ForeignKey('exercise_catalog.id', ondelete='RESTRICT'), primary_key=True, index=True)
