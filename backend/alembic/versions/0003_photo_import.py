"""photo import

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-20

PLAN.md §5.6: `puzzles.source` and `games.source` (`generated` | `imported`, default
`generated`), and `puzzles.difficulty` becomes nullable (only imported puzzles are Unrated).

The downgrade is lossy: the old schema cannot tell imported games apart, so they would reach the
leaderboard. It therefore deletes imported games (with their hint events) and imported puzzles.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("puzzles", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("source", sa.String(length=16), nullable=False, server_default="generated")
        )
        batch_op.alter_column("difficulty", existing_type=sa.String(length=16), nullable=True)
    with op.batch_alter_table("games", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("source", sa.String(length=16), nullable=False, server_default="generated")
        )


def downgrade() -> None:
    imported_games = (
        "SELECT id FROM games WHERE source = 'imported' OR puzzle_id IN "
        "(SELECT id FROM puzzles WHERE source = 'imported' OR difficulty IS NULL)"
    )
    op.execute(f"DELETE FROM hint_events WHERE game_id IN ({imported_games})")  # noqa: S608
    op.execute(f"DELETE FROM games WHERE id IN ({imported_games})")  # noqa: S608
    bad_puzzles = "SELECT id FROM puzzles WHERE source = 'imported' OR difficulty IS NULL"
    op.execute(f"DELETE FROM puzzle_pool WHERE puzzle_id IN ({bad_puzzles})")  # noqa: S608
    op.execute(
        "DELETE FROM puzzles WHERE (source = 'imported' OR difficulty IS NULL) "
        "AND id NOT IN (SELECT puzzle_id FROM games)"
    )
    with op.batch_alter_table("games", schema=None) as batch_op:
        batch_op.drop_column("source")
    with op.batch_alter_table("puzzles", schema=None) as batch_op:
        batch_op.alter_column("difficulty", existing_type=sa.String(length=16), nullable=False)
        batch_op.drop_column("source")
