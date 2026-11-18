from __future__ import annotations

from typing import Any, cast

import pytest
from sudoku_validator import Difficulty, Grid, parse, solve, validate_puzzle

from .reference import CLASSIC, LEVEL_PUZZLES, MULTI_SOLUTION, TWO_SOLUTIONS

HARD = parse(LEVEL_PUZZLES["hard"])
HARD_SOL = solve(HARD)
assert HARD_SOL is not None


def test_valid_puzzle_full_check() -> None:
    report = validate_puzzle(HARD, HARD_SOL, Difficulty.HARD)
    assert report.is_valid, report.errors
    assert report.is_consistent
    assert report.solution_count == 1
    assert report.solution_matches is True
    assert report.difficulty_matches is True
    assert report.rating.difficulty is Difficulty.HARD
    assert report.errors == []


def test_valid_puzzle_without_optional_args() -> None:
    report = validate_puzzle(HARD)
    assert report.is_valid
    assert report.solution_matches is None
    assert report.difficulty_matches is None


def test_claimed_as_string_value() -> None:
    report = validate_puzzle(HARD, claimed=cast(Any, "hard"))
    assert report.is_valid
    assert report.difficulty_matches is True


@pytest.mark.parametrize("level", [d for d in Difficulty if d is not Difficulty.HARD])
def test_mislabelled_difficulty_rejected(level: Difficulty) -> None:
    report = validate_puzzle(HARD, HARD_SOL, level)
    assert not report.is_valid
    assert report.difficulty_matches is False
    assert report.solution_matches is True
    assert any("claimed difficulty" in e for e in report.errors)


def test_unknown_claimed_level() -> None:
    report = validate_puzzle(HARD, claimed=cast(Any, "impossible"))
    assert not report.is_valid
    assert report.difficulty_matches is False
    assert any("not a known level" in e for e in report.errors)


@pytest.mark.parametrize("puzzle", [MULTI_SOLUTION, TWO_SOLUTIONS])
def test_multiple_solutions_rejected(puzzle: str) -> None:
    report = validate_puzzle(parse(puzzle), claimed=Difficulty.EASY)
    assert not report.is_valid
    assert report.is_consistent
    assert report.solution_count == 2
    assert report.rating.difficulty is None
    assert report.difficulty_matches is False
    assert "puzzle has more than one solution" in report.errors


def test_inconsistent_givens_rejected() -> None:
    givens = list(HARD)
    givens[0] = givens[1] = 7  # duplicate in row 1
    report = validate_puzzle(tuple(givens), HARD_SOL, Difficulty.HARD)
    assert not report.is_valid
    assert not report.is_consistent
    assert report.solution_count == 0
    assert report.solution_matches is False
    assert report.difficulty_matches is False
    assert any("duplicate" in e for e in report.errors)


def test_no_solution_rejected() -> None:
    report = validate_puzzle(parse("12345678." + "........9" + "." * 63))
    assert not report.is_valid
    assert report.is_consistent
    assert report.solution_count == 0
    assert "puzzle has no solution" in report.errors


def _swap(sol: Grid, a: int, b: int) -> Grid:
    cells = list(sol)
    cells[a], cells[b] = cells[b], cells[a]
    return tuple(cells)


def test_wrong_solution_rejected() -> None:
    assert HARD_SOL is not None
    # Breaks the rules.
    broken = _swap(HARD_SOL, 0, 1)
    report = validate_puzzle(HARD, broken)
    assert not report.is_valid
    assert report.solution_matches is False
    assert "supplied solution breaks the sudoku rules" in report.errors
    # Valid sudoku but contradicts a given.
    other = parse(
        "534678912672195348198342567859761423426853791713924856961537284287419635345286179"
    )
    report = validate_puzzle(HARD, other)
    assert not report.is_valid
    assert report.solution_matches is False
    assert "supplied solution contradicts the givens" in report.errors
    # Incomplete.
    report = validate_puzzle(HARD, (0,) * 81)
    assert not report.is_valid
    assert report.solution_matches is False
    assert "solution is incomplete" in report.errors


def test_other_solution_of_multi_solution_puzzle() -> None:
    givens = parse(TWO_SOLUTIONS)
    solution = solve(givens)
    assert solution is not None
    report = validate_puzzle(givens, solution)
    assert not report.is_valid
    assert report.solution_matches is False


def test_logically_unsolvable_rejected() -> None:
    givens = parse(CLASSIC["easter_monster"])
    report = validate_puzzle(givens, solve(givens))
    assert not report.is_valid
    assert report.solution_count == 1
    assert report.solution_matches is True
    assert report.rating.difficulty is None
    assert "logical solver cannot finish the puzzle without guessing" in report.errors


@pytest.mark.parametrize(
    ("givens", "message"),
    [
        ((0,) * 80, "givens has 80 cells, expected 81"),
        ("0" * 81, "givens must be a sequence of 81 ints"),
        (None, "givens must be a sequence of 81 ints"),
        ((10,) + (0,) * 80, "givens contains values outside 0-9"),
    ],
)
def test_malformed_givens(givens: object, message: str) -> None:
    report = validate_puzzle(cast(Grid, givens), claimed=Difficulty.EASY)
    assert not report.is_valid
    assert not report.is_consistent
    assert report.errors == [message]
    assert report.difficulty_matches is False
    assert report.solution_matches is None


def test_malformed_solution() -> None:
    report = validate_puzzle(HARD, (1,) * 10)
    assert not report.is_valid
    assert report.solution_matches is False
    assert "solution has 10 cells, expected 81" in report.errors
    assert report.rating.difficulty is Difficulty.HARD


def test_malformed_both() -> None:
    report = validate_puzzle((0,) * 3, (0,) * 3)
    assert report.errors == ["givens has 3 cells, expected 81", "solution has 3 cells, expected 81"]


@pytest.mark.parametrize("level", list(Difficulty))
def test_every_level_validates(level: Difficulty) -> None:
    givens = parse(LEVEL_PUZZLES[level.value])
    report = validate_puzzle(givens, solve(givens), level)
    assert report.is_valid, report.errors


def test_logical_and_backtracking_disagreement_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sudoku_validator import report as report_module
    from sudoku_validator.logical_solver import SolveResult
    from sudoku_validator.rating import rate_with_result as real
    from sudoku_validator.state import State

    def fake(grid: Grid, count: int) -> tuple[Any, SolveResult]:
        rating, result = real(grid, count)
        assert HARD_SOL is not None
        bogus = State(_swap(HARD_SOL, 0, 1), result.final.cands)
        return rating, SolveResult(result.steps, bogus, True)

    monkeypatch.setattr(report_module, "rate_with_result", fake)
    report = validate_puzzle(HARD, HARD_SOL, Difficulty.HARD)
    assert not report.is_valid
    assert report.rating.difficulty is None
    assert "logical solver result differs from the backtracking solution" in report.errors
