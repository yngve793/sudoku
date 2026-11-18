from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from sudoku_api.models.base import Base, UTCDateTime, utcnow


class Puzzle(Base):
    __tablename__ = "puzzles"

    id: Mapped[int] = mapped_column(primary_key=True)
    givens: Mapped[str] = mapped_column(String(81), unique=True)
    solution: Mapped[str] = mapped_column(String(81))
    difficulty: Mapped[str] = mapped_column(String(16), index=True)
    rating_score: Mapped[int] = mapped_column(Integer)
    techniques: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    clue_count: Mapped[int] = mapped_column(Integer)
    seed: Mapped[int | None] = mapped_column(BigInteger, default=None)
    generator_version: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    validated_at: Mapped[datetime] = mapped_column(UTCDateTime())


class PuzzlePool(Base):
    """Unassigned, pre-validated puzzles waiting to be handed out."""

    __tablename__ = "puzzle_pool"

    puzzle_id: Mapped[int] = mapped_column(
        ForeignKey("puzzles.id", ondelete="CASCADE"), primary_key=True
    )
    difficulty: Mapped[str] = mapped_column(String(16), index=True)
    reserved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), default=None)
