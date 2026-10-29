"""Add a durable idempotency key for new game rounds.

Revision ID: 4b85bc97c302
Revises: 22eb807a100b
"""
from alembic import op
import sqlalchemy as sa

revision = '4b85bc97c302'
down_revision = '22eb807a100b'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('exercise_results', sa.Column('round_id', sa.String(length=36), nullable=True))
    op.create_unique_constraint('uq_exercise_results_round_id', 'exercise_results', ['round_id'])


def downgrade() -> None:
    op.drop_constraint('uq_exercise_results_round_id', 'exercise_results', type_='unique')
    op.drop_column('exercise_results', 'round_id')
