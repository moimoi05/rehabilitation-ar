"""Version research capture and enforce one automatic capture per trial only."""
from alembic import op
import sqlalchemy as sa

revision = 'd32f_research_capture_phase1'
down_revision = 'c21f_free_drawing'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('capture_runs', sa.Column('capture_mode', sa.String(16), server_default='manual', nullable=False))
    op.add_column('capture_runs', sa.Column('capture_schema_version', sa.Integer(), server_default='1', nullable=False))
    op.create_check_constraint('ck_capture_mode', 'capture_runs', "capture_mode IN ('manual','per_trial')")
    op.create_index('uq_capture_auto_trial', 'capture_runs', ['trial_id'], unique=True,
                    postgresql_where=sa.text("capture_mode = 'per_trial'"))
    # Keep the same activity/result meaning; enable it in both managed workflows.
    op.execute(sa.text("UPDATE exercise_catalog SET usage_mode = 'both' WHERE code = 'free_drawing' AND renderer = 'free_drawing' AND usage_mode = 'training'"))


def downgrade():
    op.drop_index('uq_capture_auto_trial', table_name='capture_runs')
    op.drop_constraint('ck_capture_mode', 'capture_runs', type_='check')
    op.drop_column('capture_runs', 'capture_schema_version')
    op.drop_column('capture_runs', 'capture_mode')
    # Preserve clinical catalog references and authored settings on rollback.
