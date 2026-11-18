"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-11-18

Tables from PLAN.md §5.3: users, refresh_tokens, email_tokens, puzzles, puzzle_pool,
games (with a partial unique index: one in-progress game per user) and hint_events.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "puzzles",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("givens", sa.String(length=81), nullable=False),
        sa.Column("solution", sa.String(length=81), nullable=False),
        sa.Column("difficulty", sa.String(length=16), nullable=False),
        sa.Column("rating_score", sa.Integer(), nullable=False),
        sa.Column("techniques", sa.JSON(), nullable=False),
        sa.Column("clue_count", sa.Integer(), nullable=False),
        sa.Column("seed", sa.BigInteger(), nullable=True),
        sa.Column("generator_version", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("validated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_puzzles")),
        sa.UniqueConstraint("givens", name=op.f("uq_puzzles_givens")),
    )
    with op.batch_alter_table("puzzles", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_puzzles_difficulty"), ["difficulty"], unique=False)

    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("username", sa.String(length=20), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
        sa.UniqueConstraint("username", name=op.f("uq_users_username")),
    )
    # Case-insensitive username uniqueness (functional index; works on SQLite and Postgres).
    op.create_index("uq_users_username_lower", "users", [sa.text("lower(username)")], unique=True)
    op.create_table(
        "email_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_email_tokens_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_email_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_email_tokens_token_hash")),
    )
    with op.batch_alter_table("email_tokens", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_email_tokens_user_id"), ["user_id"], unique=False)

    op.create_table(
        "games",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("puzzle_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("current", sa.String(length=81), nullable=False),
        sa.Column("notes", sa.JSON(), nullable=False),
        sa.Column("elapsed_seconds", sa.Integer(), nullable=False),
        sa.Column("hints_used", sa.Integer(), nullable=False),
        sa.Column("mistakes", sa.Integer(), nullable=False),
        sa.Column("score", sa.Integer(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["puzzle_id"], ["puzzles.id"], name=op.f("fk_games_puzzle_id_puzzles")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_games_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_games")),
    )
    with op.batch_alter_table("games", schema=None) as batch_op:
        batch_op.create_index(
            "ix_games_leaderboard", ["status", "score", "completed_at"], unique=False
        )
        batch_op.create_index(batch_op.f("ix_games_puzzle_id"), ["puzzle_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_games_user_id"), ["user_id"], unique=False)
        batch_op.create_index(
            "uq_games_user_in_progress",
            ["user_id"],
            unique=True,
            sqlite_where=sa.text("status = 'in_progress'"),
            postgresql_where=sa.text("status = 'in_progress'"),
        )

    op.create_table(
        "puzzle_pool",
        sa.Column("puzzle_id", sa.Integer(), nullable=False),
        sa.Column("difficulty", sa.String(length=16), nullable=False),
        sa.Column("reserved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["puzzle_id"],
            ["puzzles.id"],
            name=op.f("fk_puzzle_pool_puzzle_id_puzzles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("puzzle_id", name=op.f("pk_puzzle_pool")),
    )
    with op.batch_alter_table("puzzle_pool", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_puzzle_pool_difficulty"), ["difficulty"], unique=False)

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_refresh_tokens_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refresh_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_refresh_tokens_token_hash")),
    )
    with op.batch_alter_table("refresh_tokens", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_refresh_tokens_user_id"), ["user_id"], unique=False)

    op.create_table(
        "hint_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("technique", sa.String(length=64), nullable=True),
        sa.Column("cells", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["game_id"], ["games.id"], name=op.f("fk_hint_events_game_id_games"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_hint_events")),
    )
    with op.batch_alter_table("hint_events", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_hint_events_game_id"), ["game_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("hint_events", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_hint_events_game_id"))

    op.drop_table("hint_events")
    with op.batch_alter_table("refresh_tokens", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_refresh_tokens_user_id"))

    op.drop_table("refresh_tokens")
    with op.batch_alter_table("puzzle_pool", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_puzzle_pool_difficulty"))

    op.drop_table("puzzle_pool")
    with op.batch_alter_table("games", schema=None) as batch_op:
        batch_op.drop_index(
            "uq_games_user_in_progress",
            sqlite_where=sa.text("status = 'in_progress'"),
            postgresql_where=sa.text("status = 'in_progress'"),
        )
        batch_op.drop_index(batch_op.f("ix_games_user_id"))
        batch_op.drop_index(batch_op.f("ix_games_puzzle_id"))
        batch_op.drop_index("ix_games_leaderboard")

    op.drop_table("games")
    with op.batch_alter_table("email_tokens", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_email_tokens_user_id"))

    op.drop_table("email_tokens")
    op.drop_index("uq_users_username_lower", table_name="users")
    op.drop_table("users")
    with op.batch_alter_table("puzzles", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_puzzles_difficulty"))

    op.drop_table("puzzles")
