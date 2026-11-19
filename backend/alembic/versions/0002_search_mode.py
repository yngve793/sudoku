"""search mode

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-19

PLAN.md §5.5: `games.search_tree` (the player's what-if tree, JSON, nullable) and
`games.auto_placements` (cells auto-filled by search propagation, counted for scoring).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("games", schema=None) as batch_op:
        batch_op.add_column(sa.Column("search_tree", sa.JSON(none_as_null=True), nullable=True))
        batch_op.add_column(
            sa.Column("auto_placements", sa.Integer(), nullable=False, server_default=sa.text("0"))
        )


def downgrade() -> None:
    with op.batch_alter_table("games", schema=None) as batch_op:
        batch_op.drop_column("auto_placements")
        batch_op.drop_column("search_tree")
