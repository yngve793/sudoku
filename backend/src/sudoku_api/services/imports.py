"""Photo import (PLAN.md §5.6): live review check and starting a game from a reviewed board.

Never returns or compares against the solution of the board the player sees. `check_board`
counts solutions and rates the *givens* only; whether handwritten entries are correct is
never revealed (only constraint violations in `current`, which the player can see anyway).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal, cast

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from sudoku_api.domain import Difficulty, GameSource, GameStatus
from sudoku_api.errors import ApiError
from sudoku_api.models import Game, Puzzle, PuzzlePool, User, utcnow
from sudoku_api.services import puzzle_logic
from sudoku_api.services.games import abandon_in_progress, ensure_givens_kept
from sudoku_api.services.generation import JobError, PuzzleGenerator
from sudoku_api.services.pool import insert_puzzle_ignoring_duplicates

logger = logging.getLogger(__name__)

IMPORT_GENERATOR_VERSION = "import"

SolutionCount = Literal[0, 1, 2]


@dataclass(frozen=True)
class BoardCheck:
    contradiction: puzzle_logic.Contradiction | None
    solution_count: SolutionCount
    difficulty: Difficulty | None
    rating_score: int | None


def _constraint_check(
    givens: str, current: str
) -> tuple[puzzle_logic.Contradiction | None, SolutionCount]:
    ensure_givens_kept(givens, current)
    contradiction = puzzle_logic.find_contradiction(puzzle_logic.parse(current))
    count = cast(SolutionCount, puzzle_logic.givens_solution_count(givens))
    return contradiction, count


async def rate_import(
    runner: PuzzleGenerator, givens: str, timeout: float
) -> puzzle_logic.GivensRating | None:
    """`validate_puzzle(givens)` in the worker pool; None if it timed out or the worker died."""
    try:
        return await runner.run_job(timeout, puzzle_logic.rate_givens, givens)
    except JobError as exc:
        logger.warning("rating an imported puzzle failed: %s", exc)
        return None


def _difficulty(rating: puzzle_logic.GivensRating | None) -> Difficulty | None:
    if rating is None or not rating.is_valid_import or rating.difficulty is None:
        return None
    return Difficulty(rating.difficulty)


async def check_board(
    runner: PuzzleGenerator, givens: str, current: str, rating_timeout: float
) -> BoardCheck:
    contradiction, count = await run_in_threadpool(_constraint_check, givens, current)
    rating = await rate_import(runner, givens, rating_timeout) if count == 1 else None
    valid = rating is not None and rating.is_valid_import
    return BoardCheck(
        contradiction=contradiction,
        solution_count=count,
        difficulty=_difficulty(rating),
        rating_score=rating.rating_score if valid and rating is not None else None,
    )


def validate_import_board(givens: str, current: str) -> None:
    """422 unless `current` keeps the givens and the givens have exactly one solution."""
    ensure_givens_kept(givens, current)
    grid = puzzle_logic.parse(givens)
    if not puzzle_logic.is_consistent(grid):
        raise ApiError(
            422, "puzzle_inconsistent", "The givens repeat a digit in a row, column or box"
        )
    count = puzzle_logic.count_solutions(grid, 2)
    if count == 0:
        raise ApiError(422, "no_solution", "The givens have no solution")
    if count >= 2:
        raise ApiError(422, "multiple_solutions", "The givens have more than one solution")


def needs_rating(session: Session, givens: str) -> bool:
    """False when a row with a final rating exists (it is reused as is): skips the pool job."""
    score = session.execute(
        select(Puzzle.rating_score).where(Puzzle.givens == givens)
    ).one_or_none()
    return score is None or score[0] is None


def _is_final(rating: puzzle_logic.GivensRating | None) -> bool:
    return rating is not None and rating.is_valid_import


def _reuse(session: Session, puzzle: Puzzle, rating: puzzle_logic.GivensRating | None) -> Puzzle:
    """Reuse an existing row for an import, in the caller's transaction.

    * Its pool entry is removed: givens known from a photo must never be served later as a
      fresh generated (ranked) game.
    * A pending rating (`rating_score` NULL, from an earlier timeout) is completed with
      `rating` when this request managed to rate the puzzle.
    """
    session.execute(delete(PuzzlePool).where(PuzzlePool.puzzle_id == puzzle.id))
    if puzzle.rating_score is None and rating is not None and _is_final(rating):
        difficulty = _difficulty(rating)
        puzzle.difficulty = None if difficulty is None else str(difficulty)
        puzzle.rating_score = rating.rating_score
        puzzle.techniques = dict(rating.techniques)
        puzzle.validated_at = utcnow()
    return puzzle


def _imported_puzzle(
    session: Session, givens: str, rating: puzzle_logic.GivensRating | None
) -> Puzzle:
    """The `puzzles` row for these givens: an existing one (any source) or a new imported one.

    `rating` None (timeout) stores a *pending* rating: `rating_score` NULL, re-rated on reuse.
    """
    existing = session.scalar(select(Puzzle).where(Puzzle.givens == givens))
    if existing is not None:
        return _reuse(session, existing, rating)
    grid = puzzle_logic.parse(givens)
    solution = puzzle_logic.solve(grid)
    assert solution is not None  # uniqueness was checked by validate_import_board
    difficulty = _difficulty(rating)
    now = utcnow()
    new_id = insert_puzzle_ignoring_duplicates(
        session,
        {
            "givens": givens,
            "solution": puzzle_logic.format_grid(solution),
            "difficulty": None if difficulty is None else str(difficulty),
            "source": str(GameSource.imported),
            "rating_score": rating.rating_score if _is_final(rating) and rating else None,
            "techniques": dict(rating.techniques) if _is_final(rating) and rating else {},
            "clue_count": sum(1 for v in grid if v),
            "seed": None,
            "generator_version": IMPORT_GENERATOR_VERSION,
            "created_at": now,
            "validated_at": now,
        },
    )
    if new_id is not None:
        puzzle = session.get(Puzzle, new_id)
        assert puzzle is not None
        return puzzle
    puzzle = session.scalar(select(Puzzle).where(Puzzle.givens == givens))  # concurrent insert
    assert puzzle is not None
    return _reuse(session, puzzle, rating)


def import_game(
    session: Session,
    user: User,
    givens: str,
    current: str,
    rating: puzzle_logic.GivensRating | None,
) -> Game:
    """Start an imported game. Imported puzzles are never added to the pool.

    The caller has run `validate_import_board`. A reused row keeps its stored rating; a
    new row stores `rating` (None, e.g. after a rating timeout, means Unrated).
    """
    validate_import_board(givens, current)  # cheap; keeps the service safe on its own
    now = utcnow()
    abandon_in_progress(session, user, now)
    puzzle = _imported_puzzle(session, givens, rating)
    game = Game(
        user_id=user.id,
        puzzle_id=puzzle.id,
        puzzle=puzzle,
        status=str(GameStatus.in_progress),
        source=str(GameSource.imported),
        current=current,
        notes={},
        elapsed_seconds=0,
        hints_used=0,
        mistakes=0,
        version=1,
        started_at=now,
        updated_at=now,
    )
    session.add(game)
    session.commit()
    return game
