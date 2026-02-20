"""add image_reviews table

Revision ID: 20260220_0003
Revises: 20251005_0002
Create Date: 2026-02-20
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '20260220_0003'
down_revision = '20251005_0002'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'image_reviews',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('image_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('data_instances.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('project_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('projects.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('reviewer_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id'),
                  nullable=False),
        sa.Column('status', sa.String(50), nullable=False, index=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    )


def downgrade():
    op.drop_table('image_reviews')
