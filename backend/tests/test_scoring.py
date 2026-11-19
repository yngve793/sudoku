from __future__ import annotations

import itertools

import pytest
from sudoku_api.domain import Difficulty
from sudoku_api.services.scoring import (
    AUTO_PLACEMENT_PENALTY,
    BASE_POINTS,
    PAR_SECONDS,
    compute_score,
    hint_cost,
    time_factor,
)


def test_base_points_match_plan() -> None:
    assert [BASE_POINTS[d] for d in Difficulty] == [50, 100, 250, 500, 1000, 2000, 4000]


@pytest.mark.parametrize(
    ("elapsed", "expected"),
    [(0, 1.5), (100, 1.5), (100 + 150, 1.0), (400, 0.5), (10_000, 0.5)],
)
def test_time_factor(elapsed: int, expected: float) -> None:
    assert time_factor(elapsed, 100) == pytest.approx(expected)


def test_time_factor_monotonic() -> None:
    values = [time_factor(t, 300) for t in range(0, 1500, 7)]
    assert all(a >= b for a, b in itertools.pairwise(values))


def test_perfect_game() -> None:
    s = compute_score(Difficulty.extreme, 60, [], 0)
    assert s.total == 6000
    assert s.time_factor == 1.5
    assert s.par_seconds == PAR_SECONDS[Difficulty.extreme]


def test_penalties() -> None:
    s = compute_score(Difficulty.medium, 0, [1, 2, 3], 2)
    assert s.hint_penalty == hint_cost(1) + hint_cost(2) + hint_cost(3) == 70
    assert s.mistake_penalty == 30
    assert s.total == 375 - 70 - 30


def test_floored_at_zero() -> None:
    assert compute_score(Difficulty.beginner, 10_000, [3] * 10, 10).total == 0


def test_stage_costs_increase() -> None:
    assert hint_cost(1) < hint_cost(2) < hint_cost(3)


def test_search_penalty() -> None:
    assert AUTO_PLACEMENT_PENALTY == 2
    s = compute_score(Difficulty.medium, 0, [1], 1, auto_placements=12)
    assert s.search_penalty == 24
    assert s.total == 375 - 10 - 15 - 24
    assert compute_score(Difficulty.medium, 0, [], 0).search_penalty == 0


def test_search_penalty_floored_at_zero() -> None:
    s = compute_score(Difficulty.beginner, 0, [], 0, auto_placements=81 * 10)
    assert s.search_penalty == 1620
    assert s.total == 0
