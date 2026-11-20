"""Small shared enums used by models, schemas and services."""

from __future__ import annotations

from enum import StrEnum


class Difficulty(StrEnum):
    beginner = "beginner"
    easy = "easy"
    medium = "medium"
    hard = "hard"
    expert = "expert"
    master = "master"
    extreme = "extreme"


class GameStatus(StrEnum):
    in_progress = "in_progress"
    completed = "completed"
    abandoned = "abandoned"


class GameSource(StrEnum):
    """Where a game's puzzle came from. Imported games never reach the leaderboard."""

    generated = "generated"
    imported = "imported"


class EmailTokenPurpose(StrEnum):
    verify_email = "verify_email"
    reset_password = "reset_password"  # noqa: S105 - enum value, not a secret


class LeaderboardPeriod(StrEnum):
    day = "day"
    week = "week"
    all = "all"
