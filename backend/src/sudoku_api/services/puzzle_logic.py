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
    find_contradiction,
    find_errors,
    format_grid,
    next_hint,
    propagate,
    rate,
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
    "find_contradiction",
    "find_errors",
    "format_grid",
    "generate",
    "next_hint",
    "parse",
    "propagate",
    "rate",
    "rated_difficulty",
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
