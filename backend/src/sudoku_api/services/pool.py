"""Puzzle storage and the pre-generated puzzle pool."""

from __future__ import annotations

import logging
from collections import Counter
from enum import StrEnum
from typing import Any

from sqlalchemy import Select, delete, func, insert, select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from sudoku_api.domain import Difficulty
from sudoku_api.models import Puzzle, PuzzlePool, utcnow
from sudoku_api.services import puzzle_logic
from sudoku_api.services.puzzle_source import (
    NoPuzzleAvailableError,
    PuzzleSource,
    PuzzleSourceError,
    SourcePuzzle,
)

logger = logging.getLogger(__name__)

MAX_FAILURES_PER_LEVEL = 5


class PuzzleRejectedError(Exception):
    """The candidate failed `validate_puzzle` and was not stored."""


class AddResult(StrEnum):
    added = "added"
    duplicate = "duplicate"
    rejected = "rejected"


def _insert_ignoring_duplicates(session: Session, values: dict[str, Any]) -> int | None:
    """INSERT the puzzle unless its `givens` already exist. Returns the new id or None.

    Uses ON CONFLICT DO NOTHING on SQLite/Postgres, so a concurrent insert of the same
    givens can never raise or poison the surrounding transaction.
    """
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        pg = postgresql.insert(Puzzle).values(**values)
        return session.scalar(
            pg.on_conflict_do_nothing(index_elements=["givens"]).returning(Puzzle.id)
        )
    if dialect == "sqlite":
        lite = sqlite.insert(Puzzle).values(**values)
        return session.scalar(
            lite.on_conflict_do_nothing(index_elements=["givens"]).returning(Puzzle.id)
        )
    try:  # pragma: no cover - other dialects are not supported in deployment
        with session.begin_nested():
            return session.scalar(insert(Puzzle).values(**values).returning(Puzzle.id))
    except IntegrityError:  # pragma: no cover
        return None


def store_puzzle(
    session: Session, candidate: SourcePuzzle, generator_version: str
) -> tuple[Puzzle, bool]:
    """Validate and insert a puzzle; returns `(puzzle, created)`.

    Defense in depth: nothing reaches `puzzles` without passing `validate_puzzle`, and the
    stored rating is the validator's recomputed one. If the givens already exist, the existing
    row is returned with `created=False`. Does not commit.
    """
    try:
        givens = puzzle_logic.parse(candidate.givens)
        solution = puzzle_logic.parse(candidate.solution)
    except ValueError as exc:
        logger.warning("rejected puzzle (unparseable): %s", exc)
        raise PuzzleRejectedError(str(exc)) from exc
    report = puzzle_logic.validate_puzzle(givens, solution, claimed=candidate.difficulty)
    if not report.is_valid:
        reason = "; ".join(report.errors) or "validation failed"
        logger.warning(
            "rejected puzzle claimed=%s givens=%s: %s",
            candidate.difficulty,
            candidate.givens,
            reason,
        )
        raise PuzzleRejectedError(reason)

    now = utcnow()
    givens_str = puzzle_logic.format_grid(givens)
    new_id = _insert_ignoring_duplicates(
        session,
        {
            "givens": givens_str,
            "solution": puzzle_logic.format_grid(solution),
            "difficulty": str(candidate.difficulty),
            "rating_score": report.rating.score,
            "techniques": dict(report.rating.techniques),
            "clue_count": sum(1 for v in givens if v),
            "seed": candidate.seed,
            "generator_version": generator_version,
            "created_at": now,
            "validated_at": now,
        },
    )
    if new_id is not None:
        puzzle = session.get(Puzzle, new_id)
        assert puzzle is not None
        return puzzle, True
    existing = session.scalar(select(Puzzle).where(Puzzle.givens == givens_str))
    assert existing is not None
    return existing, False


def add_to_pool(session: Session, candidate: SourcePuzzle, generator_version: str) -> AddResult:
    """Store a new puzzle and make it available in the pool. Does not commit.

    A puzzle whose givens are already known (pooled or handed out) is never re-pooled.
    """
    try:
        puzzle, created = store_puzzle(session, candidate, generator_version)
    except PuzzleRejectedError:
        return AddResult.rejected
    if not created:
        return AddResult.duplicate
    session.add(PuzzlePool(puzzle_id=puzzle.id, difficulty=str(candidate.difficulty)))
    session.flush()
    return AddResult.added


def add_to_pool_committed(
    session_factory: sessionmaker[Session], candidate: SourcePuzzle, generator_version: str
) -> AddResult:
    with session_factory() as session:
        result = add_to_pool(session, candidate, generator_version)
        if result is AddResult.added:
            session.commit()
        else:
            session.rollback()
        return result


def pool_counts(session: Session) -> dict[Difficulty, int]:
    rows = session.execute(
        select(PuzzlePool.difficulty, func.count())
        .where(PuzzlePool.reserved_at.is_(None))
        .group_by(PuzzlePool.difficulty)
    ).all()
    counts = dict.fromkeys(Difficulty, 0)
    for difficulty, n in rows:
        counts[Difficulty(difficulty)] = int(n)
    return counts


def pool_size(session: Session, difficulty: Difficulty) -> int:
    return pool_counts(session)[difficulty]


class RefillPass:
    """Book-keeping for one refill pass: always fill the level with the fewest puzzles next,
    and give up on a level for this pass after repeated failures."""

    def __init__(self, target_per_level: int, difficulties: list[Difficulty] | None = None):
        self.target = target_per_level
        self.levels = list(difficulties or Difficulty)
        self.added: dict[Difficulty, int] = dict.fromkeys(self.levels, 0)
        self._failures: Counter[Difficulty] = Counter()
        self._skip: set[Difficulty] = set()

    def next_level(self, session: Session) -> Difficulty | None:
        counts = pool_counts(session)
        open_levels = [d for d in self.levels if d not in self._skip and counts[d] < self.target]
        if not open_levels:
            return None
        return min(open_levels, key=lambda d: (counts[d], self.levels.index(d)))

    def unavailable(self, level: Difficulty) -> None:
        self._skip.add(level)

    def record(self, level: Difficulty, result: AddResult | None) -> None:
        """`result=None` means the source failed to produce a candidate."""
        if result is AddResult.added:
            self.added[level] += 1
            return
        self._failures[level] += 1
        if self._failures[level] >= MAX_FAILURES_PER_LEVEL:
            logger.warning("giving up on %s for this refill pass", level)
            self._skip.add(level)


def refill_pool(
    session_factory: sessionmaker[Session],
    source: PuzzleSource,
    target_per_level: int,
    difficulties: list[Difficulty] | None = None,
    timeout: float | None = None,
) -> dict[Difficulty, int]:
    """Synchronous refill (tests, scripts). The app's worker uses the async version in
    `workers/pool.py`, which generates off the event loop. Returns puzzles added per level."""
    refill = RefillPass(target_per_level, difficulties)
    while True:
        with session_factory() as session:
            level = refill.next_level(session)
        if level is None:
            return refill.added
        try:
            candidate = source.get(level, timeout)
        except NoPuzzleAvailableError:
            refill.unavailable(level)
            continue
        except PuzzleSourceError as exc:
            logger.warning("puzzle generation failed for %s: %s", level, exc)
            refill.record(level, None)
            continue
        refill.record(
            level, add_to_pool_committed(session_factory, candidate, source.generator_version)
        )


def _claim_candidates(session: Session, difficulty: Difficulty) -> Select[int]:
    stmt = (
        select(PuzzlePool.puzzle_id)
        .where(PuzzlePool.difficulty == str(difficulty), PuzzlePool.reserved_at.is_(None))
        .order_by(PuzzlePool.puzzle_id)
        .limit(1)
    )
    if session.get_bind().dialect.name == "postgresql":
        # Concurrent requests skip rows another transaction is already claiming.
        stmt = stmt.with_for_update(skip_locked=True)
    return stmt


def take_from_pool(session: Session, difficulty: Difficulty) -> Puzzle | None:
    """Atomically remove one puzzle from the pool (within the caller's transaction)."""
    for _ in range(5):
        puzzle_id = session.scalar(_claim_candidates(session, difficulty))
        if puzzle_id is None:
            return None
        # The DELETE is the claim: only one transaction can remove the row.
        result = session.execute(delete(PuzzlePool).where(PuzzlePool.puzzle_id == puzzle_id))
        if getattr(result, "rowcount", 0) == 1:
            return session.get(Puzzle, puzzle_id)
    return None
