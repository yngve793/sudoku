from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, ForeignKey, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from sudoku_api.models.base import Base, UTCDateTime, utcnow
from sudoku_api.models.puzzle import Puzzle

_IN_PROGRESS = text("status = 'in_progress'")


class Game(Base):
    __tablename__ = "games"
    __table_args__ = (
        # At most one in-progress game per user.
        Index(
            "uq_games_user_in_progress",
            "user_id",
            unique=True,
            sqlite_where=_IN_PROGRESS,
            postgresql_where=_IN_PROGRESS,
        ),
        Index("ix_games_leaderboard", "status", "score", "completed_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    puzzle_id: Mapped[int] = mapped_column(ForeignKey("puzzles.id"), index=True)
    status: Mapped[str] = mapped_column(String(16))
    current: Mapped[str] = mapped_column(String(81))
    notes: Mapped[dict[str, list[int]]] = mapped_column(JSON, default=dict)
    elapsed_seconds: Mapped[int] = mapped_column(Integer, default=0)
    hints_used: Mapped[int] = mapped_column(Integer, default=0)
    mistakes: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[int | None] = mapped_column(Integer, default=None)
    version: Mapped[int] = mapped_column(Integer, default=1)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), default=None)

    puzzle: Mapped[Puzzle] = relationship(lazy="joined")


class HintEvent(Base):
    __tablename__ = "hint_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    level: Mapped[int] = mapped_column(Integer)  # hint stage 1..3
    technique: Mapped[str | None] = mapped_column(String(64), default=None)
    cells: Mapped[list[int]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
