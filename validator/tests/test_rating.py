from __future__ import annotations

import itertools

import pytest
from sudoku_validator import (
    BEGINNER_MAX_SCORE,
    DIFFICULTY_TECHNIQUES,
    TECHNIQUE_LEVEL,
    TECHNIQUE_WEIGHTS,
    Difficulty,
    parse,
    rate,
    solve,
)
from sudoku_validator.rating import classify

from .reference import CLASSIC, LEVEL_PUZZLES, MULTI_SOLUTION, TWO_SOLUTIONS


def test_difficulty_order() -> None:
    assert [d.value for d in Difficulty] == [
        "beginner",
        "easy",
        "medium",
        "hard",
        "expert",
        "master",
        "extreme",
    ]
    assert [d.rank for d in Difficulty] == list(range(7))
    assert Difficulty("hard") is Difficulty.HARD


def test_weights_match_plan() -> None:
    assert TECHNIQUE_WEIGHTS["Naked Single"] == 1
    assert TECHNIQUE_WEIGHTS["Hidden Single"] == 2
    assert TECHNIQUE_WEIGHTS["Locked Candidates"] == 5
    assert TECHNIQUE_WEIGHTS["Naked Pair"] == 8
    assert TECHNIQUE_WEIGHTS["Hidden Pair"] == 10
    assert TECHNIQUE_WEIGHTS["Naked Triple"] == 15
    assert TECHNIQUE_WEIGHTS["Hidden Triple"] == 18
    assert TECHNIQUE_WEIGHTS["X-Wing"] == 25
    assert TECHNIQUE_WEIGHTS["Naked Quad"] == TECHNIQUE_WEIGHTS["Hidden Quad"] == 30
    assert TECHNIQUE_WEIGHTS["Swordfish"] == TECHNIQUE_WEIGHTS["XY-Wing"] == 40
    assert TECHNIQUE_WEIGHTS["XYZ-Wing"] == 50
    assert TECHNIQUE_WEIGHTS["Jellyfish"] == 60
    assert TECHNIQUE_WEIGHTS["Simple Coloring"] == TECHNIQUE_WEIGHTS["X-Chain"] == 60
    assert TECHNIQUE_WEIGHTS["W-Wing"] == 65
    assert TECHNIQUE_WEIGHTS["Unique Rectangle"] == 70
    assert TECHNIQUE_WEIGHTS["XY-Chain"] == 90
    assert TECHNIQUE_WEIGHTS["ALS-XZ"] == 110
    assert TECHNIQUE_WEIGHTS["Forcing Chain"] == 150


def test_difficulty_techniques_cumulative() -> None:
    assert set(TECHNIQUE_LEVEL) == set(TECHNIQUE_WEIGHTS)
    assert DIFFICULTY_TECHNIQUES[Difficulty.BEGINNER] == ("Naked Single", "Hidden Single")
    assert DIFFICULTY_TECHNIQUES[Difficulty.EASY] == DIFFICULTY_TECHNIQUES[Difficulty.BEGINNER]
    assert "X-Wing" in DIFFICULTY_TECHNIQUES[Difficulty.HARD]
    assert "X-Wing" not in DIFFICULTY_TECHNIQUES[Difficulty.MEDIUM]
    assert "Unique Rectangle" in DIFFICULTY_TECHNIQUES[Difficulty.MASTER]
    assert DIFFICULTY_TECHNIQUES[Difficulty.EXTREME] == tuple(TECHNIQUE_WEIGHTS)
    levels = list(Difficulty)
    for lower, higher in itertools.pairwise(levels):
        assert set(DIFFICULTY_TECHNIQUES[lower]) <= set(DIFFICULTY_TECHNIQUES[higher])


def test_classify() -> None:
    assert classify({"Naked Single": 30}, 30) is Difficulty.BEGINNER
    assert classify({"Naked Single": 40}, BEGINNER_MAX_SCORE) is Difficulty.BEGINNER
    assert classify({"Naked Single": 50}, BEGINNER_MAX_SCORE + 1) is Difficulty.EASY
    assert classify({"Naked Single": 50, "Naked Pair": 1}, 58) is Difficulty.MEDIUM
    assert classify({"Naked Single": 50, "X-Wing": 1, "Naked Pair": 2}, 91) is Difficulty.HARD
    assert classify({"XYZ-Wing": 1}, 50) is Difficulty.EXPERT
    assert classify({"XY-Wing": 1}, 40) is Difficulty.HARD
    assert classify({"W-Wing": 1, "Naked Pair": 0}, 65) is Difficulty.EXPERT
    assert classify({"XY-Chain": 1}, 90) is Difficulty.MASTER
    assert classify({"Forcing Chain": 1}, 150) is Difficulty.EXTREME


@pytest.mark.parametrize("level", list(Difficulty))
def test_level_reference_puzzles(level: Difficulty) -> None:
    rating = rate(parse(LEVEL_PUZZLES[level.value]))
    assert rating.solved_logically
    assert rating.difficulty is level
    assert rating.score == sum(TECHNIQUE_WEIGHTS[t] * n for t, n in rating.techniques.items())
    assert sum(rating.techniques.values()) == len(rating.steps)
    allowed = set(DIFFICULTY_TECHNIQUES[level])
    assert set(rating.techniques) <= allowed


def test_rate_steps_reach_solution() -> None:
    grid = parse(CLASSIC["wikipedia"])
    rating = rate(grid)
    sol = solve(grid)
    assert sol is not None
    placed = dict.fromkeys(range(81), 0)
    for i, v in enumerate(grid):
        placed[i] = v
    for step in rating.steps:
        for c, d in step.placements:
            placed[c] = d
    assert tuple(placed[i] for i in range(81)) == sol
    assert rating.difficulty is Difficulty.EASY or rating.difficulty is Difficulty.BEGINNER


def test_rate_unsolvable_logically() -> None:
    rating = rate(parse(CLASSIC["easter_monster"]))
    assert rating.difficulty is None
    assert not rating.solved_logically


@pytest.mark.parametrize("puzzle", [MULTI_SOLUTION, TWO_SOLUTIONS, "11" + "." * 79])
def test_rate_invalid(puzzle: str) -> None:
    rating = rate(parse(puzzle))
    assert rating.difficulty is None
    assert not rating.solved_logically
    assert rating.score == 0
    assert rating.steps == []
    assert rating.techniques == {}


def test_rate_malformed() -> None:
    assert rate((10,) + (0,) * 80).difficulty is None
    with pytest.raises(ValueError, match="81"):
        rate((0,) * 3)


def test_rate_solved_grid() -> None:
    sol = solve(parse(CLASSIC["wikipedia"]))
    assert sol is not None
    rating = rate(sol)
    assert rating.solved_logically
    assert rating.difficulty is Difficulty.BEGINNER
    assert rating.score == 0


def test_logical_solve_without_uniqueness_cannot_finish_two_solution_grid() -> None:
    from sudoku_validator.logical_solver import logical_solve

    result = logical_solve(parse(TWO_SOLUTIONS), allow_uniqueness=False)
    assert not result.solved
    assert all(step.technique != "Unique Rectangle" for step in result.steps)
