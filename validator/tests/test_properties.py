"""Property-based tests over seeded random puzzles."""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from sudoku_validator import count_solutions, is_consistent, rate, solve, validate_puzzle
from sudoku_validator.grid import is_complete_solution

from .puzzle_factory import random_puzzle

seeds = st.integers(min_value=0, max_value=10**9)


@settings(max_examples=40, deadline=None)
@given(seed=seeds)
def test_solve_satisfies_constraints(seed: int) -> None:
    givens, solution = random_puzzle(seed)
    assert is_consistent(givens)
    assert count_solutions(givens) == 1
    found = solve(givens)
    assert found == solution
    assert is_complete_solution(found)
    assert all(g == 0 or g == s for g, s in zip(givens, found, strict=True))


@settings(max_examples=40, deadline=None)
@given(seed=seeds)
def test_every_logical_step_matches_unique_solution(seed: int) -> None:
    givens, solution = random_puzzle(seed)
    rating = rate(givens)
    for step in rating.steps:
        assert step.placements or step.eliminations
        for cell, digit in step.placements:
            assert solution[cell] == digit, step
        for cell, digit in step.eliminations:
            assert solution[cell] != digit, step
        assert all(0 <= c < 81 for c in step.cells)
    if rating.solved_logically:
        assert rating.difficulty is not None
        report = validate_puzzle(givens, solution, rating.difficulty)
        assert report.is_valid, report.errors
    else:
        assert rating.difficulty is None


@settings(max_examples=25, deadline=None)
@given(seed=seeds, clues=st.integers(min_value=30, max_value=50))
def test_non_minimal_puzzles(seed: int, clues: int) -> None:
    givens, solution = random_puzzle(seed, min_clues=clues)
    assert sum(1 for v in givens if v) >= clues
    rating = rate(givens)
    for step in rating.steps:
        assert all(solution[c] == d for c, d in step.placements)
        assert all(solution[c] != d for c, d in step.eliminations)
