"""Thin adapter over the puzzle-logic packages (`sudoku_validator`, `sudoku_generator`).

The backend never implements Sudoku logic itself; every call goes through this module.

* `validate_puzzle`, `find_errors`, `next_hint`, `rate`, `parse`, `format_grid` and
  `cell_name` are the real `sudoku_validator` implementations (PLAN.md §5.1).
* `propagate` and `find_contradiction` (with `Propagation`, `Placement`, `Contradiction`)
  are the validator's constraint-only search-mode helpers (PLAN.md §5.5).
* `generate`, `Puzzle`, `Symmetry` and `GenerationError` are the real `sudoku_generator`
  API (PLAN.md §5.2). `GENERATOR_VERSION` is the installed package version.
"""

from __future__ import annotations

from importlib.metadata import version
from typing import NamedTuple

import sudoku_generator as sg
import sudoku_validator as sv
from sudoku_generator import GenerationError, Puzzle, Symmetry
from sudoku_validator import (
    Contradiction,
    Grid,
    Hint,
    Placement,
    Propagation,
    Rating,
    Step,
    ValidationReport,
    cell_name,
    count_solutions,
    find_contradiction,
    find_errors,
    format_grid,
    is_consistent,
    next_hint,
    propagate,
    rate,
    solve,
)

from sudoku_api.domain import Difficulty

GENERATOR_VERSION = version("sudoku-generator")
GRID_SIZE = 81

__all__ = [
    "GENERATOR_VERSION",
    "Contradiction",
    "GenerationError",
    "Grid",
    "Hint",
    "Placement",
    "Propagation",
    "Puzzle",
    "Rating",
    "Step",
    "Symmetry",
    "ValidationReport",
    "cell_name",
    "count_solutions",
    "find_contradiction",
    "find_errors",
    "format_grid",
    "generate",
    "is_consistent",
    "next_hint",
    "parse",
    "propagate",
    "rate",
    "rated_difficulty",
    "solve",
    "validate_puzzle",
]


def to_validator_difficulty(difficulty: Difficulty) -> sv.Difficulty:
    return sv.Difficulty(str(difficulty))


def rated_difficulty(rating: Rating) -> Difficulty | None:
    """The backend `Difficulty` for a validator rating (None if unrated)."""
    return None if rating.difficulty is None else Difficulty(str(rating.difficulty))


def parse(s: str) -> Grid:
    """Strict parse of an 81-character grid string (`0` or `.` = empty)."""
    if len(s) != GRID_SIZE:
        raise ValueError("grid must have 81 cells")
    return sv.parse(s)


def validate_puzzle(
    givens: Grid, solution: Grid | None = None, claimed: Difficulty | None = None
) -> ValidationReport:
    """All six validator checks (shape, consistency, uniqueness, solution, logic, rating)."""
    return sv.validate_puzzle(
        givens, solution, None if claimed is None else to_validator_difficulty(claimed)
    )


def generate(
    difficulty: Difficulty,
    *,
    seed: int | None = None,
    symmetry: Symmetry = Symmetry.ROTATIONAL,
    timeout: float | None = None,
) -> Puzzle:
    """`sudoku_generator.generate`; raises `GenerationError` when the budget runs out."""
    return sg.generate(
        to_validator_difficulty(difficulty), seed=seed, symmetry=symmetry, timeout=timeout
    )


def givens_solution_count(givens: str) -> int:
    """0 (inconsistent or unsolvable), 1, or 2 meaning two or more. Constraint-only."""
    grid = parse(givens)
    if not is_consistent(grid):
        return 0
    return min(count_solutions(grid, 2), 2)


class GivensRating(NamedTuple):
    """Picklable summary of `validate_puzzle(givens)` for an imported puzzle."""

    is_valid_import: bool  # consistent and exactly one solution (checks 2 and 3)
    difficulty: str | None  # None = Unrated (needs techniques beyond the rated set)
    rating_score: int
    techniques: dict[str, int]


def rate_givens(givens: str) -> GivensRating:
    """The insertion gate for imports: `validate_puzzle` without a claimed level.

    Top-level and picklable so it can run in the worker process pool. A puzzle the logical
    solver cannot finish is still importable, but Unrated.
    """
    report = validate_puzzle(parse(givens))
    rating = report.rating
    return GivensRating(
        is_valid_import=report.is_consistent and report.solution_count == 1,
        difficulty=None if rating.difficulty is None else str(rating.difficulty),
        rating_score=rating.score,
        techniques=dict(rating.techniques),
    )
