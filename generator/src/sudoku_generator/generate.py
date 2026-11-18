"""Difficulty-targeted puzzle generation: :func:`generate`.

One *attempt* works on a fresh random solution grid:

1. **Dig** (uniqueness only, cheap): visit the symmetry orbits in random order
   and keep every removal that leaves exactly one solution, recording the
   path of intermediate puzzles up to a minimal one.
2. **Locate the target on the path**: rate the minimal puzzle. If it is
   harder than the target (or not logically solvable), binary-search the
   path for the last puzzle that is still at most the target level. Rating
   is close to monotone along the path, so this finds the point where the
   puzzle crosses into the target level. Easy levels are therefore reached
   by *stopping early*, long before the puzzle becomes minimal.
3. **Refine**: from that point, keep trying the orbits not yet removed,
   rating after each accepted removal and **undoing removals that overshoot**
   the target or make the puzzle unsolvable without guessing. The last puzzle
   rated exactly at the target is the attempt's result, so each level gets
   as few clues as it can hold (e.g. beginner digs right up to its score band).
4. If the attempt did not hit the target, **restart** with a new grid (and a
   new removal order), bounded by ``max_attempts`` and ``timeout``.

Every result passes the **final gate**,
``validate_puzzle(givens, solution, claimed=difficulty).is_valid``, before it
is returned. Each attempt is bounded: at most one uniqueness check per orbit
for digging, ``log2(path)`` ratings for the search and one rating per
remaining orbit for refinement.
"""

from __future__ import annotations

import random
import secrets
import time
from dataclasses import dataclass
from typing import Final

from sudoku_validator import Difficulty, Grid, Rating, count_solutions, rate, validate_puzzle

from .digger import removal_order, remove
from .full_grid import random_full_grid
from .symmetry import Symmetry

#: Default ``max_attempts`` per level. Hard levels are rarer per attempt
#: (see the benchmark), so they get more restarts; an attempt costs ~10-60 ms.
DEFAULT_MAX_ATTEMPTS: Final[dict[Difficulty, int]] = {
    Difficulty.BEGINNER: 50,
    Difficulty.EASY: 50,
    Difficulty.MEDIUM: 200,
    Difficulty.HARD: 500,
    Difficulty.EXPERT: 500,
    Difficulty.MASTER: 2000,
    Difficulty.EXTREME: 2000,
}


class GenerationError(RuntimeError):
    """No puzzle of the requested level was found within the given budget."""


@dataclass(frozen=True)
class Puzzle:
    """A validated puzzle. ``seed`` reproduces it via ``generate(..., seed=seed)``.

    Reproduction also requires the same ``symmetry`` (default rotational).
    """

    givens: Grid
    solution: Grid
    difficulty: Difficulty
    rating: Rating
    seed: int

    @property
    def clue_count(self) -> int:
        return sum(1 for v in self.givens if v)


@dataclass(frozen=True)
class GenerationResult:
    """A puzzle plus how much work it took (used by the CLI stats and benchmark)."""

    puzzle: Puzzle
    attempts: int
    elapsed: float


def _within(rating: Rating, target: Difficulty) -> bool:
    """Solvable logically and no harder than *target*."""
    return rating.difficulty is not None and rating.difficulty.rank <= target.rank


def _attempt(
    target: Difficulty, rng: random.Random, symmetry: Symmetry
) -> tuple[Grid, Grid, Rating] | None:
    """One attempt on a fresh grid; returns ``(givens, solution, rating)`` or ``None``."""
    solution = random_full_grid(rng)
    order = removal_order(symmetry, rng)

    # 1. Uniqueness-only dig, recording the path. path[k] has k removals.
    path: list[Grid] = [solution]
    removed_at: list[int] = []  # removed_at[k] = index in `order` of the k-th removal
    grid = solution
    for idx, orbit in enumerate(order):
        candidate = remove(grid, orbit)
        if count_solutions(candidate, limit=2) == 1:
            grid = candidate
            path.append(grid)
            removed_at.append(idx)

    # 2. Find the last point on the path that is <= target.
    final_rating = rate(path[-1])
    if _within(final_rating, target):
        if final_rating.difficulty is target:
            return path[-1], solution, final_rating
        return None  # minimal yet too easy: this grid cannot reach the target
    lo, hi = 0, len(path) - 1  # invariant: path[lo] within target, path[hi] not
    lo_rating: Rating | None = None
    while hi - lo > 1:
        mid = (lo + hi) // 2
        mid_rating = rate(path[mid])
        if _within(mid_rating, target):
            lo, lo_rating = mid, mid_rating
        else:
            hi = mid
    grid = path[lo]
    rating = lo_rating if lo_rating is not None else rate(grid)

    # 3. Refine: try the orbits after the crossing, undoing overshoots.
    best = (grid, rating) if rating.difficulty is target else None
    start = removed_at[lo] + 1 if lo < len(removed_at) else len(order)
    for orbit in order[start:]:
        candidate = remove(grid, orbit)
        if candidate == grid or count_solutions(candidate, limit=2) != 1:
            continue
        candidate_rating = rate(candidate)
        if not _within(candidate_rating, target):
            continue  # overshoot or needs guessing: undo, try the next orbit
        grid, rating = candidate, candidate_rating
        if rating.difficulty is target:
            best = (grid, rating)
    if best is None:
        return None
    return best[0], solution, best[1]


def generate_with_stats(
    difficulty: Difficulty,
    *,
    seed: int | None = None,
    symmetry: Symmetry = Symmetry.ROTATIONAL,
    max_attempts: int | None = None,
    timeout: float | None = None,
) -> GenerationResult:
    """Like :func:`generate` but also reports attempts and elapsed time."""
    difficulty = Difficulty(difficulty)
    symmetry = Symmetry(symmetry)
    if seed is None:
        seed = secrets.randbits(63)
    budget = DEFAULT_MAX_ATTEMPTS[difficulty] if max_attempts is None else max_attempts
    if budget < 1:
        raise ValueError("max_attempts must be at least 1")
    rng = random.Random(seed)  # noqa: S311 - reproducible puzzles, not cryptography
    start = time.perf_counter()
    deadline = None if timeout is None else start + timeout
    attempts = 0
    while attempts < budget:
        if deadline is not None and attempts and time.perf_counter() >= deadline:
            raise GenerationError(
                f"timed out after {timeout} s and {attempts} attempts "
                f"generating a {difficulty.value} puzzle (seed={seed})"
            )
        attempts += 1
        found = _attempt(difficulty, rng, symmetry)
        if found is None:
            continue
        givens, solution, _ = found
        # Final gate: the validator independently re-checks everything.
        report = validate_puzzle(givens, solution, claimed=difficulty)
        if not report.is_valid:
            continue
        puzzle = Puzzle(givens, solution, difficulty, report.rating, seed)
        return GenerationResult(puzzle, attempts, time.perf_counter() - start)
    raise GenerationError(f"no {difficulty.value} puzzle found in {budget} attempts (seed={seed})")


def generate(
    difficulty: Difficulty,
    *,
    seed: int | None = None,
    symmetry: Symmetry = Symmetry.ROTATIONAL,
    max_attempts: int | None = None,
    timeout: float | None = None,
) -> Puzzle:
    """Generate a validated puzzle of exactly *difficulty*.

    The same ``(difficulty, seed, symmetry, max_attempts)`` always gives the same puzzle;
    ``seed=None`` draws a fresh seed (recorded in :attr:`Puzzle.seed`).
    ``max_attempts`` defaults to a per-level value (:data:`DEFAULT_MAX_ATTEMPTS`).
    ``timeout`` (seconds) is checked between attempts, so it may be exceeded by
    one attempt (well under a second). Raises :class:`GenerationError` if no
    puzzle is found within the budget.
    """
    return generate_with_stats(
        difficulty, seed=seed, symmetry=symmetry, max_attempts=max_attempts, timeout=timeout
    ).puzzle
