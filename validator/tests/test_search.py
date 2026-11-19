"""Tests for the search-mode API: find_contradiction and propagate."""

from __future__ import annotations

import json
import random
from dataclasses import FrozenInstanceError, asdict

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from sudoku_validator import (
    Contradiction,
    Grid,
    Placement,
    Propagation,
    find_contradiction,
    is_consistent,
    parse,
    propagate,
    solve,
)
from sudoku_validator.grid import UNITS
from sudoku_validator.state import State

from .contradiction_cases import (
    CASES,
    FIXTURE,
    NO_CANDIDATES,
    SOLVED,
    WIKIPEDIA,
    board,
    fixture_data,
    row,
    transpose,
)
from .puzzle_factory import random_puzzle
from .reference import CLASSIC, LEVEL_PUZZLES

# --------------------------------------------------------------------------
# find_contradiction


@pytest.mark.parametrize(("name", "grid", "intent"), CASES, ids=[c[0] for c in CASES])
def test_case_intent(name: str, grid: Grid, intent: tuple[str, str | None] | None) -> None:
    found = find_contradiction(grid)
    if intent is None:
        assert found is None
    else:
        assert found is not None
        assert (found.kind, found.unit) == intent


def test_fixture_is_up_to_date() -> None:
    data = json.loads(FIXTURE.read_text())
    assert data == fixture_data()
    assert 15 <= len(data) <= 25
    kinds = {c["expected"]["kind"] for c in data if c["expected"]}
    assert kinds == {"duplicate", "no_candidates", "digit_nowhere"}
    for case in data:
        assert len(case["grid"]) == 81
        assert set(case["grid"]) <= set("0123456789")


def test_duplicate_fields() -> None:
    found = find_contradiction(board((3, 2, 7), (3, 8, 7)))
    assert found == Contradiction(
        kind="duplicate",
        cells=(19, 25),
        digit=7,
        unit="row 3",
        explanation="7 appears twice in row 3 (r3c2, r3c8).",
    )


@pytest.mark.parametrize(
    ("grid", "unit", "cells"),
    [
        (board((1, 1, 5), (1, 9, 5)), "row 1", (0, 8)),
        (board((2, 5, 5), (9, 5, 5)), "column 5", (13, 76)),
        (board((7, 7, 5), (9, 9, 5)), "box 9", (60, 80)),
        (board((4, 2, 5), (5, 1, 5)), "box 4", (28, 36)),
    ],
)
def test_duplicate_in_each_unit_kind(grid: Grid, unit: str, cells: tuple[int, ...]) -> None:
    found = find_contradiction(grid)
    assert found is not None
    assert (found.kind, found.unit, found.cells, found.digit) == ("duplicate", unit, cells, 5)


def test_duplicate_many_times() -> None:
    found = find_contradiction(row(1, "444400000"))
    assert found is not None
    assert found.cells == (0, 1, 2, 3)
    assert "4 times" in found.explanation


def test_no_candidates_fields() -> None:
    found = find_contradiction(NO_CANDIDATES)
    assert found == Contradiction(
        kind="no_candidates",
        cells=(0,),
        digit=None,
        unit=None,
        explanation=(
            "No digit can go in r1c1: every digit from 1 to 9 already appears "
            "in its row, column or box."
        ),
    )


@pytest.mark.parametrize(
    ("grid", "cell"),
    [
        # Blocked by its row (1-8) plus a 9 in its column.
        (board((5, 1, 9), base=row(1, "012345678")), 0),
        # Blocked by its column (1-8) plus a 9 in its row.
        (board((1, 9, 9), base=transpose(row(1, "012345678"))), 0),
        # Blocked by its box (1-8) plus a 9 in its row.
        (board((5, 9, 9), (4, 4, 1), (4, 5, 2), (4, 6, 3), (5, 4, 4), (5, 6, 5),
               (6, 4, 6), (6, 5, 7), (6, 6, 8)), 40),
    ],
)  # fmt: skip
def test_no_candidates_each_unit_kind(grid: Grid, cell: int) -> None:
    found = find_contradiction(grid)
    assert found is not None
    assert (found.kind, found.cells) == ("no_candidates", (cell,))


def test_digit_nowhere_row_column_box() -> None:
    by_name = {name: grid for name, grid, _ in CASES}
    for name, unit, cells in [
        ("digit nowhere in row", "row 1", (0, 1, 2)),
        ("digit nowhere in column", "column 1", (0, 9, 18)),
        ("digit nowhere in box", "box 1", (0, 10)),
    ]:
        found = find_contradiction(by_name[name])
        assert found is not None
        assert (found.kind, found.unit, found.digit, found.cells) == (
            "digit_nowhere",
            unit,
            5,
            cells,
        )
        assert found.explanation.startswith(f"5 cannot be placed anywhere in {unit}")


def test_contradiction_ordering() -> None:
    # Duplicates in a column and a box only: column comes first.
    found = find_contradiction(board((1, 1, 3), (9, 1, 3), (5, 5, 4), (6, 6, 4)))
    assert found is not None
    assert found.unit == "column 1"
    # Two duplicate rows: the lower row first.
    found = find_contradiction(board((8, 1, 1), (8, 9, 1), (2, 1, 2), (2, 9, 2)))
    assert found is not None
    assert found.unit == "row 2"
    # Two candidate-less cells: row-major order.
    grid = board((7, 9, 9), base=row(9, "123456780", base=NO_CANDIDATES))
    found = find_contradiction(grid)
    assert found is not None
    assert found.cells == (0,)
    assert found == find_contradiction(grid)


def test_valid_boards_have_no_contradiction() -> None:
    assert find_contradiction((0,) * 81) is None
    assert find_contradiction(SOLVED) is None
    for text in [*CLASSIC.values(), *LEVEL_PUZZLES.values()]:
        assert find_contradiction(parse(text)) is None


def test_accepts_lists() -> None:
    assert find_contradiction(list(SOLVED)) is None  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "grid",
    [
        (0,) * 80,
        (0,) * 82,
        (10,) + (0,) * 80,
        (-1,) + (0,) * 80,
        (True,) + (0,) * 80,
        "0" * 81,
    ],
)
def test_malformed_grid_raises(grid: object) -> None:
    with pytest.raises(ValueError, match="grid must"):
        find_contradiction(grid)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="grid must"):
        propagate(grid)  # type: ignore[arg-type]


def test_results_are_frozen() -> None:
    found = find_contradiction(board((1, 1, 5), (1, 9, 5)))
    assert found is not None
    with pytest.raises(FrozenInstanceError):
        found.kind = "no_candidates"  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        Placement(0, 1, "Naked Single").value = 2  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        propagate(SOLVED).grid = SOLVED  # type: ignore[misc]


def test_contradiction_asdict_shape() -> None:
    found = find_contradiction(board((1, 1, 5), (1, 9, 5)))
    assert found is not None
    assert list(asdict(found)) == ["kind", "cells", "digit", "unit", "explanation"]


# --------------------------------------------------------------------------
# propagate


def _replay(start: Grid, result: Propagation) -> None:
    """Check every placement really is the claimed single at its point in time."""
    state = State.from_grid(start)
    values = list(start)
    for p in result.placements:
        assert values[p.cell] == 0
        bit = 1 << p.value
        assert state.cands[p.cell] & bit
        if p.technique == "Naked Single":
            assert state.cands[p.cell] == bit
        else:
            assert any(
                p.cell in unit and [c for c in unit if state.cands[c] & bit] == [p.cell]
                for unit in UNITS
            )
        values[p.cell] = p.value
        state = State.from_grid(tuple(values))
    assert tuple(values) == result.grid


def test_propagate_solves_singles_puzzle() -> None:
    grid = WIKIPEDIA
    solution = solve(grid)
    result = propagate(grid)
    assert result.contradiction is None
    assert result.grid == solution
    assert len(result.placements) == grid.count(0)
    _replay(grid, result)
    assert {p.technique for p in result.placements} <= {"Naked Single", "Hidden Single"}


@pytest.mark.parametrize("text", [*CLASSIC.values(), *LEVEL_PUZZLES.values()])
def test_propagate_agrees_with_solution(text: str) -> None:
    grid = parse(text)
    solution = solve(grid)
    assert solution is not None
    result = propagate(grid)
    assert result.contradiction is None
    for p in result.placements:
        assert solution[p.cell] == p.value
    _replay(grid, result)


@settings(max_examples=40, deadline=None)
@given(seed=st.integers(0, 10**9), fill=st.floats(0.0, 0.6))
def test_propagate_on_correct_partial_boards(seed: int, fill: float) -> None:
    givens, solution = random_puzzle(seed)
    rng = random.Random(seed)
    board_ = tuple(
        s if g or rng.random() < fill else 0 for g, s in zip(givens, solution, strict=True)
    )
    result = propagate(board_)
    assert result.contradiction is None
    assert all(solution[p.cell] == p.value for p in result.placements)
    _replay(board_, result)


def test_both_techniques_are_recorded() -> None:
    techniques = set()
    for seed in range(20):
        givens, _ = random_puzzle(seed)
        techniques |= {p.technique for p in propagate(givens).placements}
    assert techniques == {"Naked Single", "Hidden Single"}


def test_wrong_guess_runs_into_contradiction() -> None:
    # r1c3 = 2 is wrong (the solution has 4) but not immediately contradictory.
    guess = board((1, 3, 2), base=WIKIPEDIA)
    assert find_contradiction(guess) is None
    result = propagate(guess)
    assert result.contradiction is not None
    assert result.placements
    assert result.contradiction == find_contradiction(result.grid)
    # It stopped at the first contradiction: one placement fewer is still fine.
    shorter = propagate(guess, max_placements=len(result.placements) - 1)
    assert shorter.contradiction is None
    assert shorter.placements == result.placements[:-1]
    _replay(guess, result)


def test_every_wrong_guess_is_detected_or_consistent() -> None:
    solution = solve(WIKIPEDIA)
    assert solution is not None
    dead = 0
    for cell in range(81):
        if WIKIPEDIA[cell]:
            continue
        for digit in range(1, 10):
            if digit == solution[cell]:
                continue
            guess = board((cell // 9 + 1, cell % 9 + 1, digit), base=WIKIPEDIA)
            result = propagate(guess)
            if result.contradiction is not None:
                dead += 1
                assert result.contradiction == find_contradiction(result.grid)
            else:
                assert result.grid[cell] == digit
                assert is_consistent(result.grid)
    assert dead > 0


def test_already_contradictory_grid() -> None:
    for grid in (NO_CANDIDATES, board((1, 1, 5), (1, 9, 5))):
        result = propagate(grid)
        assert result.placements == ()
        assert result.grid == grid
        assert result.contradiction == find_contradiction(grid)
        assert result.contradiction is not None


def test_max_placements() -> None:
    full = propagate(WIKIPEDIA)
    for limit in (0, 1, 5, 20):
        limited = propagate(WIKIPEDIA, max_placements=limit)
        assert limited.placements == full.placements[:limit]
        assert limited.contradiction is None
    assert propagate(WIKIPEDIA, max_placements=0).grid == WIKIPEDIA
    assert propagate(WIKIPEDIA, max_placements=1000) == full
    with pytest.raises(ValueError, match="max_placements"):
        propagate(WIKIPEDIA, max_placements=-1)


def test_propagate_is_deterministic() -> None:
    for seed in range(10):
        givens, _ = random_puzzle(seed)
        assert propagate(givens) == propagate(givens)
        assert propagate(list(givens)) == propagate(givens)  # type: ignore[arg-type]
    # Naked singles come first, in row-major order.
    first = propagate(WIKIPEDIA).placements[0]
    assert first.technique == "Naked Single"
    state = State.from_grid(WIKIPEDIA)
    naked = [i for i in range(81) if WIKIPEDIA[i] == 0 and bin(state.cands[i]).count("1") == 1]
    assert first.cell == naked[0]


def test_nothing_to_do() -> None:
    assert propagate(SOLVED) == Propagation((), None, SOLVED)
    empty = (0,) * 81
    assert propagate(empty) == Propagation((), None, empty)


# --------------------------------------------------------------------------
# Hypothesis properties on arbitrary (possibly wrong) boards


@st.composite
def noisy_boards(draw: st.DrawFn) -> Grid:
    """A random puzzle plus a few arbitrary digits (often wrong)."""
    givens, _ = random_puzzle(draw(st.integers(0, 10**9)))
    cells = list(givens)
    for _ in range(draw(st.integers(0, 4))):
        cell = draw(st.integers(0, 80))
        if cells[cell] == 0:
            cells[cell] = draw(st.integers(1, 9))
    return tuple(cells)


sparse_boards = st.lists(
    st.one_of(st.just(0), st.just(0), st.just(0), st.integers(1, 9)), min_size=81, max_size=81
).map(tuple)


def _check_properties(grid: Grid) -> None:
    result = propagate(grid)
    out = result.grid
    # The result extends the input: filled cells are unchanged.
    assert all(g == 0 or g == o for g, o in zip(grid, out, strict=True))
    changed = [i for i in range(81) if grid[i] != out[i]]
    assert sorted(changed) == sorted(p.cell for p in result.placements)
    assert all(1 <= p.value <= 9 and out[p.cell] == p.value for p in result.placements)
    if result.contradiction is None:
        assert is_consistent(out)
        assert find_contradiction(out) is None
    else:
        assert result.contradiction == find_contradiction(out)
        if find_contradiction(grid) is not None:
            assert result.placements == ()
    assert propagate(grid) == result


@settings(max_examples=150, deadline=None)
@given(grid=noisy_boards())
def test_propagation_properties_noisy(grid: Grid) -> None:
    _check_properties(grid)


@settings(max_examples=150, deadline=None)
@given(grid=sparse_boards)
def test_propagation_properties_arbitrary(grid: Grid) -> None:
    _check_properties(grid)
