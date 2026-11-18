"""Difficulty levels and :func:`rate`."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from .grid import Grid, is_consistent, require_len
from .logical_solver import SolveResult, logical_solve
from .solver import count_solutions
from .step import Step
from .techniques import TECHNIQUE_WEIGHTS
from .techniques import base as t


class Difficulty(StrEnum):
    BEGINNER = "beginner"
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"
    EXPERT = "expert"
    MASTER = "master"
    EXTREME = "extreme"

    @property
    def rank(self) -> int:
        """0 for beginner up to 6 for extreme."""
        return _ORDER.index(self)


_ORDER: Final = tuple(Difficulty)

#: Singles-only puzzles with a score up to this value are beginner, above it easy.
BEGINNER_MAX_SCORE: Final = 42

#: The lowest level at which each technique is allowed.
TECHNIQUE_LEVEL: Final[Mapping[str, Difficulty]] = MappingProxyType(
    {
        t.NAKED_SINGLE: Difficulty.BEGINNER,
        t.HIDDEN_SINGLE: Difficulty.BEGINNER,
        t.LOCKED_CANDIDATES: Difficulty.MEDIUM,
        t.NAKED_PAIR: Difficulty.MEDIUM,
        t.HIDDEN_PAIR: Difficulty.MEDIUM,
        t.NAKED_TRIPLE: Difficulty.HARD,
        t.HIDDEN_TRIPLE: Difficulty.HARD,
        t.X_WING: Difficulty.HARD,
        t.NAKED_QUAD: Difficulty.EXPERT,
        t.HIDDEN_QUAD: Difficulty.EXPERT,
        t.SWORDFISH: Difficulty.EXPERT,
        t.XY_WING: Difficulty.HARD,
        t.XYZ_WING: Difficulty.EXPERT,
        t.SIMPLE_COLORING: Difficulty.EXPERT,
        t.X_CHAIN: Difficulty.EXPERT,
        t.JELLYFISH: Difficulty.MASTER,
        t.W_WING: Difficulty.EXPERT,
        t.UNIQUE_RECTANGLE: Difficulty.MASTER,
        t.XY_CHAIN: Difficulty.MASTER,
        t.ALS_XZ: Difficulty.EXTREME,
        t.FORCING_CHAIN: Difficulty.EXTREME,
    }
)

#: Techniques allowed at each level (cumulative), easiest first.
DIFFICULTY_TECHNIQUES: Final[Mapping[Difficulty, tuple[str, ...]]] = MappingProxyType(
    {
        level: tuple(name for name in TECHNIQUE_WEIGHTS if TECHNIQUE_LEVEL[name].rank <= level.rank)
        for level in Difficulty
    }
)


@dataclass(frozen=True)
class Rating:
    """Result of :func:`rate`.

    ``difficulty`` is ``None`` when the puzzle cannot be finished by the
    logical solver (or is invalid / not uniquely solvable). ``techniques`` maps
    technique name to the number of times it was used; ``score`` is the sum of
    weight x uses.
    """

    difficulty: Difficulty | None
    score: int
    techniques: dict[str, int]
    solved_logically: bool
    steps: list[Step]


def empty_rating() -> Rating:
    """Rating used for invalid, unsolvable or non-unique puzzles."""
    return Rating(None, 0, {}, False, [])


def classify(techniques: Mapping[str, int], score: int) -> Difficulty:
    """Level of the hardest technique used; singles-only puzzles split by score."""
    level = Difficulty.BEGINNER
    for name, count in techniques.items():
        if count and TECHNIQUE_LEVEL[name].rank > level.rank:
            level = TECHNIQUE_LEVEL[name]
    if level is Difficulty.BEGINNER and score > BEGINNER_MAX_SCORE:
        return Difficulty.EASY
    return level


def rating_from_result(result: SolveResult) -> Rating:
    counts: dict[str, int] = {}
    for step in result.steps:
        counts[step.technique] = counts.get(step.technique, 0) + 1
    ordered = {name: counts[name] for name in TECHNIQUE_WEIGHTS if name in counts}
    score = sum(TECHNIQUE_WEIGHTS[name] * n for name, n in ordered.items())
    difficulty = classify(ordered, score) if result.solved else None
    return Rating(difficulty, score, ordered, result.solved, list(result.steps))


def rate_with_result(grid: Grid, solution_count: int) -> tuple[Rating, SolveResult]:
    """Rate a consistent *grid* whose solution count (capped at 2) is known.

    Also returns the raw solve result (used by the validator).
    """
    # Uniqueness-based techniques are only sound for uniquely solvable puzzles.
    result = logical_solve(grid, allow_uniqueness=solution_count == 1)
    return rating_from_result(result), result


def rate(grid: Grid) -> Rating:
    """Solve *grid* logically and classify it.

    Invalid, inconsistent or unsolvable grids, and puzzles with more than one
    solution, get ``difficulty=None`` and ``solved_logically=False``. Raises
    :class:`ValueError` only if the grid does not have 81 cells.
    """
    require_len(grid)
    if not is_consistent(grid) or count_solutions(grid, 2) != 1:
        return empty_rating()
    rating, _ = rate_with_result(grid, 1)
    return rating
