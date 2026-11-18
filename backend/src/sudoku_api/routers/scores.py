from __future__ import annotations

import threading
import time
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from sudoku_api.deps import CurrentUserDep, DbDep, SettingsDep
from sudoku_api.domain import Difficulty, GameStatus, LeaderboardPeriod
from sudoku_api.schemas.common import error_responses
from sudoku_api.schemas.scores import (
    BestScore,
    LeaderboardEntry,
    LeaderboardMeOut,
    LeaderboardOut,
    ScoreHistoryItem,
    ScoresMeOut,
)
from sudoku_api.services import stats
from sudoku_api.services.stats import LeaderboardRow

router = APIRouter(tags=["scores"], responses=error_responses(422))


class TTLCache:
    """Tiny in-process cache for the public leaderboard."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[tuple[object, ...], tuple[float, LeaderboardOut]] = {}

    def get(self, key: tuple[object, ...]) -> LeaderboardOut | None:
        with self._lock:
            hit = self._items.get(key)
            if hit is None or hit[0] < time.monotonic():
                return None
            return hit[1]

    def put(self, key: tuple[object, ...], value: LeaderboardOut, ttl: float) -> None:
        if ttl <= 0:
            return
        with self._lock:
            if len(self._items) > 256:
                self._items.clear()
            self._items[key] = (time.monotonic() + ttl, value)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


def _entry(row: LeaderboardRow) -> LeaderboardEntry:
    return LeaderboardEntry(
        rank=row.rank,
        username=row.username,
        difficulty=row.difficulty,
        score=row.score,
        elapsed_seconds=row.elapsed_seconds,
        hints_used=row.hints_used,
        completed_at=row.completed_at,
    )


@router.get(
    "/scores/me",
    response_model=ScoresMeOut,
    responses=error_responses(401),
    summary="Personal game history and best score per difficulty",
)
def my_scores(
    db: DbDep,
    user: CurrentUserDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ScoresMeOut:
    best = [
        BestScore(
            game_id=g.id,
            difficulty=d,
            score=g.score or 0,
            elapsed_seconds=g.elapsed_seconds,
            hints_used=g.hints_used,
            completed_at=g.completed_at or g.updated_at,
        )
        for d, g in sorted(
            stats.best_scores(db, user).items(), key=lambda kv: list(Difficulty).index(kv[0])
        )
    ]
    history = [
        ScoreHistoryItem(
            game_id=g.id,
            difficulty=Difficulty(g.puzzle.difficulty),
            status=GameStatus(g.status),
            score=g.score,
            elapsed_seconds=g.elapsed_seconds,
            hints_used=g.hints_used,
            mistakes=g.mistakes,
            started_at=g.started_at,
            completed_at=g.completed_at,
        )
        for g in stats.history(db, user, limit, offset)
    ]
    return ScoresMeOut(best=best, history=history)


@router.get(
    "/leaderboard",
    response_model=LeaderboardOut,
    summary="Public leaderboard (no authentication). Never includes email addresses.",
)
def leaderboard(
    request: Request,
    response: Response,
    db: DbDep,
    settings: SettingsDep,
    difficulty: Difficulty | None = None,
    period: LeaderboardPeriod = LeaderboardPeriod.all,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> LeaderboardOut:
    cache: TTLCache = request.app.state.leaderboard_cache
    key = (difficulty, period, limit)
    ttl = settings.leaderboard_cache_seconds
    response.headers["Cache-Control"] = f"public, max-age={int(ttl)}"
    cached = cache.get(key)
    if cached is not None:
        return cached
    rows = stats.leaderboard(db, difficulty, period, limit)
    result = LeaderboardOut(difficulty=difficulty, period=period, entries=[_entry(r) for r in rows])
    cache.put(key, result, ttl)
    return result


@router.get(
    "/leaderboard/me",
    response_model=LeaderboardMeOut,
    responses=error_responses(401),
    summary="The logged-in user's best rank for the given filters",
)
def leaderboard_me(
    db: DbDep,
    user: CurrentUserDep,
    difficulty: Difficulty | None = None,
    period: LeaderboardPeriod = LeaderboardPeriod.all,
) -> LeaderboardMeOut:
    row, total = stats.leaderboard_rank(db, user, difficulty, period)
    return LeaderboardMeOut(
        difficulty=difficulty,
        period=period,
        rank=row.rank if row else None,
        total=total,
        entry=_entry(row) if row else None,
    )
