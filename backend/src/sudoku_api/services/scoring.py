"""Score formula (PLAN.md §5.3).

score = base[difficulty] x time_factor - HINT_PENALTY x Σ stage weights - MISTAKE_PENALTY x mistakes
floored at 0. time_factor is 1.5 at or under par, decays linearly to 0.5 at 4x par, and stays
at 0.5 beyond that.
"""

from __future__ import annotations

from dataclasses import dataclass

from sudoku_api.domain import Difficulty

BASE_POINTS: dict[Difficulty, int] = {
    Difficulty.beginner: 50,
    Difficulty.easy: 100,
    Difficulty.medium: 250,
    Difficulty.hard: 500,
    Difficulty.expert: 1000,
    Difficulty.master: 2000,
    Difficulty.extreme: 4000,
}

PAR_SECONDS: dict[Difficulty, int] = {
    Difficulty.beginner: 5 * 60,
    Difficulty.easy: 8 * 60,
    Difficulty.medium: 12 * 60,
    Difficulty.hard: 20 * 60,
    Difficulty.expert: 30 * 60,
    Difficulty.master: 45 * 60,
    Difficulty.extreme: 60 * 60,
}

# Hint stages: 1 = technique + region, 2 = highlighted cells, 3 = value.
STAGE_WEIGHTS: dict[int, int] = {1: 1, 2: 2, 3: 4}
HINT_PENALTY = 10
MISTAKE_PENALTY = 15

MAX_TIME_FACTOR = 1.5
MIN_TIME_FACTOR = 0.5
SLOW_MULTIPLE = 4


def hint_cost(stage: int) -> int:
    """Points deducted for requesting one hint at `stage`."""
    return HINT_PENALTY * STAGE_WEIGHTS[stage]


def time_factor(elapsed_seconds: int, par_seconds: int) -> float:
    if elapsed_seconds <= par_seconds:
        return MAX_TIME_FACTOR
    slow = par_seconds * SLOW_MULTIPLE
    if elapsed_seconds >= slow:
        return MIN_TIME_FACTOR
    progress = (elapsed_seconds - par_seconds) / (slow - par_seconds)
    return MAX_TIME_FACTOR - progress * (MAX_TIME_FACTOR - MIN_TIME_FACTOR)


@dataclass(frozen=True)
class ScoreBreakdown:
    base: int
    par_seconds: int
    time_factor: float
    hint_penalty: int
    mistake_penalty: int
    total: int


def compute_score(
    difficulty: Difficulty, elapsed_seconds: int, hint_stages: list[int], mistakes: int
) -> ScoreBreakdown:
    base = BASE_POINTS[difficulty]
    par = PAR_SECONDS[difficulty]
    factor = time_factor(max(0, elapsed_seconds), par)
    hint_pen = sum(hint_cost(s) for s in hint_stages)
    mistake_pen = MISTAKE_PENALTY * max(0, mistakes)
    total = max(0, round(base * factor) - hint_pen - mistake_pen)
    return ScoreBreakdown(
        base=base,
        par_seconds=par,
        time_factor=round(factor, 4),
        hint_penalty=hint_pen,
        mistake_penalty=mistake_pen,
        total=total,
    )
