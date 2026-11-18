"""Sudoku solver, difficulty rater, hint engine and puzzle validator.

This is the leaf package of the workspace: standard library only, and it never
imports the generator or the API.
"""

from __future__ import annotations

from .grid import Grid, cell_name, format_grid, is_consistent, parse
from .hints import Hint, find_errors, next_hint
from .rating import (
    BEGINNER_MAX_SCORE,
    DIFFICULTY_TECHNIQUES,
    TECHNIQUE_LEVEL,
    Difficulty,
    Rating,
    rate,
)
from .report import ValidationReport, validate_puzzle
from .solver import count_solutions, solve
from .step import Step
from .techniques import TECHNIQUE_WEIGHTS

__all__ = [
    "BEGINNER_MAX_SCORE",
    "DIFFICULTY_TECHNIQUES",
    "TECHNIQUE_LEVEL",
    "TECHNIQUE_WEIGHTS",
    "Difficulty",
    "Grid",
    "Hint",
    "Rating",
    "Step",
    "ValidationReport",
    "cell_name",
    "count_solutions",
    "find_errors",
    "format_grid",
    "is_consistent",
    "next_hint",
    "parse",
    "rate",
    "solve",
    "validate_puzzle",
]
