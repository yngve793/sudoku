"""Read-side queries: personal stats, score history, public leaderboard."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from sudoku_api.domain import Difficulty, GameStatus, LeaderboardPeriod
from sudoku_api.models import Game, Puzzle, User, utcnow


@dataclass(frozen=True)
class LeaderboardRow:
    rank: int
    username: str
    difficulty: Difficulty
    score: int
    elapsed_seconds: int
    hints_used: int
    completed_at: datetime


@dataclass(frozen=True)
class UserStats:
    games_started: int
    games_completed: int
    total_score: int
    best_scores: dict[Difficulty, int]


def _period_start(period: LeaderboardPeriod, now: datetime) -> datetime | None:
    if period == LeaderboardPeriod.day:
        return now - timedelta(days=1)
    if period == LeaderboardPeriod.week:
        return now - timedelta(days=7)
    return None


def _ranked_games_query(
    difficulty: Difficulty | None, period: LeaderboardPeriod
) -> Select[Game, str, str]:
    stmt = (
        select(Game, User.username, Puzzle.difficulty)
        .join(User, User.id == Game.user_id)
        .join(Puzzle, Puzzle.id == Game.puzzle_id)
        .where(
            Game.status == str(GameStatus.completed),
            Game.score.is_not(None),
            User.email_verified_at.is_not(None),  # only verified accounts are public
        )
    )
    if difficulty is not None:
        stmt = stmt.where(Puzzle.difficulty == str(difficulty))
    start = _period_start(period, utcnow())
    if start is not None:
        stmt = stmt.where(Game.completed_at >= start)
    return stmt


def leaderboard(
    session: Session, difficulty: Difficulty | None, period: LeaderboardPeriod, limit: int
) -> list[LeaderboardRow]:
    stmt = (
        _ranked_games_query(difficulty, period)
        .order_by(Game.score.desc(), Game.completed_at.asc(), Game.id.asc())
        .limit(limit)
    )
    rows: list[LeaderboardRow] = []
    for rank, (game, username, diff) in enumerate(session.execute(stmt).all(), start=1):
        assert game.score is not None
        assert game.completed_at is not None
        rows.append(
            LeaderboardRow(
                rank=rank,
                username=username,
                difficulty=Difficulty(diff),
                score=game.score,
                elapsed_seconds=game.elapsed_seconds,
                hints_used=game.hints_used,
                completed_at=game.completed_at,
            )
        )
    return rows


def leaderboard_rank(
    session: Session, user: User, difficulty: Difficulty | None, period: LeaderboardPeriod
) -> tuple[LeaderboardRow | None, int]:
    """The user's best qualifying game with its global rank, and the number of ranked games."""
    base = _ranked_games_query(difficulty, period)
    total = int(session.scalar(select(func.count()).select_from(base.subquery())) or 0)
    best = session.execute(
        base.where(Game.user_id == user.id)
        .order_by(Game.score.desc(), Game.completed_at.asc(), Game.id.asc())
        .limit(1)
    ).first()
    if best is None:
        return None, total
    game, username, diff = best
    assert game.score is not None
    assert game.completed_at is not None
    better = base.where(
        or_(
            Game.score > game.score,
            and_(Game.score == game.score, Game.completed_at < game.completed_at),
            and_(
                Game.score == game.score,
                Game.completed_at == game.completed_at,
                Game.id < game.id,
            ),
        )
    )
    ahead = int(session.scalar(select(func.count()).select_from(better.subquery())) or 0)
    row = LeaderboardRow(
        rank=ahead + 1,
        username=username,
        difficulty=Difficulty(diff),
        score=game.score,
        elapsed_seconds=game.elapsed_seconds,
        hints_used=game.hints_used,
        completed_at=game.completed_at,
    )
    return row, total


def best_scores(session: Session, user: User) -> dict[Difficulty, Game]:
    games = session.scalars(
        select(Game)
        .join(Puzzle, Puzzle.id == Game.puzzle_id)
        .where(Game.user_id == user.id, Game.status == str(GameStatus.completed))
        .order_by(Game.score.desc(), Game.completed_at.asc())
    ).all()
    best: dict[Difficulty, Game] = {}
    for game in games:
        best.setdefault(Difficulty(game.puzzle.difficulty), game)
    return best


def history(session: Session, user: User, limit: int, offset: int) -> list[Game]:
    return list(
        session.scalars(
            select(Game)
            .where(Game.user_id == user.id)
            .order_by(Game.started_at.desc(), Game.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()
    )


def user_stats(session: Session, user: User) -> UserStats:
    started = int(session.scalar(select(func.count()).where(Game.user_id == user.id)) or 0)
    completed, total = session.execute(
        select(func.count(), func.coalesce(func.sum(Game.score), 0)).where(
            Game.user_id == user.id, Game.status == str(GameStatus.completed)
        )
    ).one()
    best = {d: g.score or 0 for d, g in best_scores(session, user).items()}
    return UserStats(
        games_started=started,
        games_completed=int(completed or 0),
        total_score=int(total or 0),
        best_scores=best,
    )
