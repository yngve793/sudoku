"""provisional import rating

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-20

`puzzles.rating_score` becomes nullable. NULL marks an imported puzzle whose rating timed out:
its `difficulty` NULL is provisional and it is re-rated when imported again. A genuinely
Unrated import keeps a non-NULL `rating_score`.

Downgrade: pending ratings become 0 (the old schema cannot represent "pending").
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("puzzles", schema=None) as batch_op:
        batch_op.alter_column("rating_score", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    op.execute("UPDATE puzzles SET rating_score = 0 WHERE rating_score IS NULL")
    with op.batch_alter_table("puzzles", schema=None) as batch_op:
        batch_op.alter_column("rating_score", existing_type=sa.Integer(), nullable=False)
