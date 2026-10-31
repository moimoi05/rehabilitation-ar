"""Add nullable capture lease; existing captures are left untouched.

Revision ID: a06f_capture_lease
Revises: 7c01_capture_runs
"""
from alembic import op
import sqlalchemy as sa

revision = 'a06f_capture_lease'
down_revision = '7c01_capture_runs'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('capture_runs', sa.Column('lease_expires_at', sa.DateTime(timezone=True), nullable=True))
    op.create_index('ix_capture_runs_lease_expires_at', 'capture_runs', ['lease_expires_at'])


def downgrade():
    op.drop_index('ix_capture_runs_lease_expires_at', table_name='capture_runs')
    op.drop_column('capture_runs', 'lease_expires_at')
