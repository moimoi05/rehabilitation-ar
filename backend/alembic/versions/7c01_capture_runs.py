"""Add capture runs while preserving existing video and landmark records.

Revision ID: 7c01_capture_runs
Revises: 948b1ad2a337
"""
from alembic import op
import sqlalchemy as sa

revision = '7c01_capture_runs'
down_revision = '948b1ad2a337'
branch_labels = None
depends_on = None

def upgrade():
    op.create_table('capture_runs',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('patient_id', sa.Integer(), sa.ForeignKey('patients.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('session_id', sa.Integer(), sa.ForeignKey('sessions.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('trial_id', sa.Integer(), sa.ForeignKey('trials.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('source_type', sa.String(32), nullable=False), sa.Column('status', sa.String(20), nullable=False),
        sa.Column('record_landmarks', sa.Boolean(), nullable=False), sa.Column('record_video', sa.Boolean(), nullable=False),
        sa.Column('consent_landmarks', sa.Boolean(), nullable=False), sa.Column('consent_video', sa.Boolean(), nullable=False),
        sa.Column('started_at_utc', sa.DateTime(timezone=True), nullable=False), sa.Column('ended_at_utc', sa.DateTime(timezone=True)),
        sa.Column('start_performance_ms', sa.Float(), nullable=False), sa.Column('duration_ms', sa.Float()),
        sa.Column('video_mime_type', sa.String(128)), sa.Column('width', sa.Integer()), sa.Column('height', sa.Integer()),
        sa.Column('model_config_info', sa.JSON(), nullable=False), sa.Column('artifact_summary', sa.JSON()), sa.Column('error_message', sa.Text()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("source_type IN ('webcam','pre_recorded_video')"),
        sa.CheckConstraint("status IN ('recording','complete','incomplete','aborted')"))
    for name in ('patient_id','session_id','trial_id','status'):
        op.create_index(f'ix_capture_runs_{name}', 'capture_runs', [name])

def downgrade():
    op.drop_table('capture_runs')
