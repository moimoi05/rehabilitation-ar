"""Add optional versioned image-space Ghost anchor; legacy records remain unchanged.

Revision ID: 948b1ad2a337
Revises: 4b85bc97c302
"""
from alembic import op
import sqlalchemy as sa

revision = '948b1ad2a337'
down_revision = '4b85bc97c302'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('calibrations', sa.Column('image_anchor', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('calibrations', 'image_anchor')
