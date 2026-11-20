from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from sudoku_api.domain import Difficulty, GameSource, GameStatus, LeaderboardPeriod


class ScoreHistoryItem(BaseModel):
    game_id: int
    difficulty: Difficulty | None = Field(description="null only for Unrated imported puzzles")
    source: GameSource
    status: GameStatus
    score: int | None
    elapsed_seconds: int
    hints_used: int
    mistakes: int
    started_at: datetime
    completed_at: datetime | None


class BestScore(BaseModel):
    game_id: int
    difficulty: Difficulty
    score: int
    elapsed_seconds: int
    hints_used: int
    completed_at: datetime


class ScoresMeOut(BaseModel):
    best: list[BestScore]
    history: list[ScoreHistoryItem]


class LeaderboardEntry(BaseModel):
    """Public data only: never an email address."""

    rank: int
    username: str
    difficulty: Difficulty
    score: int
    elapsed_seconds: int
    hints_used: int
    completed_at: datetime


class LeaderboardOut(BaseModel):
    difficulty: Difficulty | None
    period: LeaderboardPeriod
    entries: list[LeaderboardEntry]


class LeaderboardMeOut(BaseModel):
    difficulty: Difficulty | None
    period: LeaderboardPeriod
    rank: int | None
    total: int
    entry: LeaderboardEntry | None


class HealthOut(BaseModel):
    status: str
    database: str
