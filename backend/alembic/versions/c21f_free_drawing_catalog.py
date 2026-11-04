"""Register the implemented Free Drawing training activity; preserve clinical data."""
from alembic import op
import sqlalchemy as sa

revision = 'c21f_free_drawing'
down_revision = 'b10f_hospital_workflows'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text("""
        INSERT INTO exercise_catalog
            (code, name, description, instructions, exercise_type, usage_mode,
             active, is_default, renderer, default_duration_seconds)
        VALUES ('free_drawing', 'Vẽ tự do',
            'Vẽ trong không khí bằng tay bên tập. Số nét và thời lượng là thông tin hoạt động, không phải điểm lâm sàng.',
            'Theo chỉ định bác sĩ, chọn cổ tay hoặc đầu ngón trỏ và chế độ hỗ trợ hoặc cử chỉ. Hạ bút để vẽ, nhấc bút để kết thúc nét. Dừng khi cần hỗ trợ.',
            'game', 'training', true, false, 'free_drawing', 60)
        ON CONFLICT (code) DO NOTHING
    """))


def downgrade():
    # Catalog configuration and its clinical references outlive application
    # rollbacks. Older frontends ignore this unsupported renderer. Keeping the
    # row also preserves authored changes and makes reapplying upgrade safe.
    pass
