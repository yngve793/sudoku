"""Constraint-assisted correction changes givens only (PLAN.md §5.6 step 6)."""

from __future__ import annotations

import pytest
from sudoku_validator import parse, solve
from sudoku_vision import CellReading
from sudoku_vision.correct import correct_givens

PUZZLE = parse("53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79")
SOLUTION = solve(PUZZLE)
assert SOLUTION is not None


def _cells(givens: tuple[int, ...], hand: dict[int, int] | None = None) -> list[CellReading]:
    hand = hand or {}
    out = []
    for i, d in enumerate(givens):
        if d:
            alts = ((d, 0.998), (d % 9 + 1, 0.001), ((d + 1) % 9 + 1, 0.001))
            out.append(CellReading(i, d, "given", 0.998, alts, False))
        elif i in hand:
            v = hand[i]
            out.append(CellReading(i, v, "handwritten", 0.6, ((v, 0.6), (1, 0.3), (2, 0.1)), False))
        else:
            out.append(CellReading(i, 0, "empty", 1.0, (), False))
    return out


def _misread(cells: list[CellReading], index: int, wrong: int, right: int) -> None:
    cells[index] = CellReading(
        index, wrong, "given", 0.5, ((wrong, 0.5), (right, 0.45), (4, 0.05)), False
    )


def test_consistent_unique_givens_are_untouched() -> None:
    cells = _cells(PUZZLE)
    out, warnings = correct_givens(cells)
    assert out == tuple(cells)
    assert warnings == ()


def test_misread_given_causing_a_duplicate_is_corrected() -> None:
    cells = _cells(PUZZLE)
    _misread(cells, 0, wrong=3, right=5)  # r1c1 is 5; a 3 duplicates r1c2
    out, warnings = correct_givens(cells)
    assert out[0].digit == 5
    assert out[0].auto_corrected
    assert out[0].kind == "given"
    assert sum(c.auto_corrected for c in out) == 1
    assert any("r1c1" in w for w in warnings)


def test_misread_given_causing_no_solution_is_corrected() -> None:
    cells = _cells(PUZZLE)
    # r1c5 is 7; reading it as 2 keeps the givens free of duplicates
    # but makes them unsolvable or ambiguous.
    _misread(cells, 4, wrong=2, right=7)
    out, _ = correct_givens(cells)
    assert out[4].digit == 7
    assert out[4].auto_corrected


def test_two_misreads_are_corrected_together() -> None:
    cells = _cells(PUZZLE)
    _misread(cells, 0, wrong=3, right=5)
    _misread(cells, 80, wrong=8, right=9)
    out, _ = correct_givens(cells)
    assert (out[0].digit, out[80].digit) == (5, 9)
    assert out[0].auto_corrected
    assert out[80].auto_corrected


def test_handwritten_cells_are_never_changed() -> None:
    # A wrong handwritten entry (r1c3 should be 4) that clashes with the given 5 in r1c1,
    # plus a given misread so that correction runs.
    cells = _cells(PUZZLE, hand={2: 5, 3: 1})
    _misread(cells, 0, wrong=3, right=5)
    out, warnings = correct_givens(cells)
    assert out[2] == cells[2]
    assert out[3] == cells[3]
    assert not out[2].auto_corrected
    assert any("handwritten r1c3" in w for w in warnings)


def test_wrong_handwritten_entry_is_not_fixed_toward_the_solution() -> None:
    cells = _cells(PUZZLE, hand={2: 2})  # r1c3 is 4 in the solution; 2 clashes with no given
    assert SOLUTION[2] == 4
    out, warnings = correct_givens(cells)
    assert out[2].digit == 2
    assert warnings == ()


def test_confident_givens_are_not_changed() -> None:
    cells = _cells(PUZZLE)
    # Both 3s in row 1 are read confidently: nothing may be "fixed".
    cells[0] = CellReading(0, 3, "given", 0.99, ((3, 0.99), (5, 0.004), (8, 0.001)), False)
    out, warnings = correct_givens(cells)
    assert not any(c.auto_corrected for c in out)
    assert "givens contradict each other" in warnings


def test_uncorrectable_givens_report_the_problem() -> None:
    cells = _cells(PUZZLE)
    # The alternatives do not contain the right digit.
    cells[0] = CellReading(0, 3, "given", 0.5, ((3, 0.5), (3, 0.3), (3, 0.2)), False)
    out, warnings = correct_givens(cells)
    assert out[0].digit == 3
    assert not any(c.auto_corrected for c in out)
    assert "givens contradict each other" in warnings


def test_multiple_solutions_are_reported() -> None:
    sparse = list(PUZZLE)
    for i in (0, 1, 4, 9, 12, 13):
        sparse[i] = 0
    out, warnings = correct_givens(_cells(tuple(sparse)))
    assert "givens have multiple solutions" in warnings
    assert not any(c.auto_corrected for c in out)


@pytest.mark.parametrize("n_givens", [0, 5])
def test_too_few_givens(n_givens: int) -> None:
    givens = tuple(SOLUTION[i] if i < n_givens else 0 for i in range(81))
    _, warnings = correct_givens(_cells(givens))
    assert warnings
    assert not any("auto-corrected" in w for w in warnings)
