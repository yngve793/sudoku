"""Sudoku puzzle generator with difficulty targeting.

Every puzzle returned has passed ``sudoku_validator.validate_puzzle`` with its
claimed difficulty.
"""

from .digger import dig
from .full_grid import random_full_grid
from .generate import (
    DEFAULT_MAX_ATTEMPTS,
    GenerationError,
    GenerationResult,
    Puzzle,
    generate,
    generate_with_stats,
)
from .symmetry import Symmetry

__all__ = [
    "DEFAULT_MAX_ATTEMPTS",
    "GenerationError",
    "GenerationResult",
    "Puzzle",
    "Symmetry",
    "dig",
    "generate",
    "generate_with_stats",
    "random_full_grid",
]
