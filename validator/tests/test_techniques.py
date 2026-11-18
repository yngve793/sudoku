"""Known-answer tests for every technique.

Most tests build an exact candidate pattern (the textbook diagram for the
technique) and check the precise deductions. Puzzle-level tests check that
each technique appears in the solve path of a reference puzzle and that every
deduction agrees with the backtracking solution.
"""

from __future__ import annotations

import pytest
from sudoku_validator import TECHNIQUE_LEVEL, parse, rate, solve
from sudoku_validator.grid import ROWS
from sudoku_validator.logical_solver import find_step
from sudoku_validator.state import ALL, BIT, State
from sudoku_validator.step import Step
from sudoku_validator.techniques import TECHNIQUE_WEIGHTS, TECHNIQUES
from sudoku_validator.techniques.als import als_xz
from sudoku_validator.techniques.chains import (
    forcing_chain,
    simple_coloring,
    x_chain,
    xy_chain,
)
from sudoku_validator.techniques.fish import jellyfish, swordfish, x_wing
from sudoku_validator.techniques.locked import locked_candidates
from sudoku_validator.techniques.singles import hidden_single, naked_single
from sudoku_validator.techniques.subsets import (
    hidden_pair,
    hidden_quad,
    hidden_triple,
    naked_pair,
    naked_quad,
    naked_triple,
)
from sudoku_validator.techniques.uniqueness import unique_rectangle
from sudoku_validator.techniques.wings import w_wing, xy_wing, xyz_wing

from .reference import CLASSIC, TECHNIQUE_PUZZLES


def rc(r: int, c: int) -> int:
    """Cell index from 1-based row/column."""
    return (r - 1) * 9 + (c - 1)


def mask(digits: str) -> int:
    m = 0
    for ch in digits:
        m |= BIT[int(ch)]
    return m


def make_state(
    cands: dict[int, str] | None = None, remove: dict[int, list[int]] | None = None
) -> State:
    """All 81 cells empty with every candidate, except as overridden.

    *cands* sets a cell's exact candidates; *remove* maps a digit to cells that
    lose it.
    """
    cells = [ALL] * 81
    for cell, digits in (cands or {}).items():
        cells[cell] = mask(digits)
    for digit, where in (remove or {}).items():
        for cell in where:
            cells[cell] &= ~BIT[digit]
    return State((0,) * 81, tuple(cells))


def elims(step: Step | None) -> list[tuple[int, int]]:
    assert step is not None
    return step.eliminations


# --------------------------------------------------------------------- singles


def test_naked_single() -> None:
    state = State.from_grid(parse("12345678." + "." * 72))
    step = naked_single(state)
    assert step is not None
    assert step.technique == "Naked Single"
    assert step.placements == [(8, 9)]
    assert step.cells == [8]
    assert "r1c9 = 9" in step.explanation


def test_hidden_single() -> None:
    grid = [0] * 81
    grid[rc(2, 5)] = 1
    grid[rc(3, 8)] = 1
    grid[rc(5, 2)] = 1
    grid[rc(8, 3)] = 1
    state = State.from_grid(tuple(grid))
    assert naked_single(state) is None
    step = hidden_single(state)
    assert step is not None
    assert step.placements == [(rc(1, 1), 1)]
    assert step.cells[0] == rc(1, 1)
    assert "in box 1, 1 can only go in r1c1" in step.explanation


def test_singles_none_on_empty_grid() -> None:
    state = State.from_grid((0,) * 81)
    assert naked_single(state) is None
    assert hidden_single(state) is None


# ------------------------------------------------------------ locked candidates


def test_locked_candidates_pointing() -> None:
    state = make_state(remove={5: [rc(r, c) for r in (2, 3) for c in (1, 2, 3)] + [rc(1, 3)]})
    step = locked_candidates(state)
    assert elims(step) == [(rc(1, c), 5) for c in range(4, 10)]
    assert step is not None
    assert "(pointing)" in step.explanation
    assert step.cells == [rc(1, 1), rc(1, 2)]


def test_locked_candidates_claiming() -> None:
    state = make_state(remove={5: [rc(1, c) for c in range(3, 10)]})
    step = locked_candidates(state)
    expected = [(rc(r, c), 5) for r in (2, 3) for c in (1, 2, 3)]
    assert elims(step) == expected
    assert step is not None
    assert "(claiming)" in step.explanation


def test_locked_candidates_none() -> None:
    assert locked_candidates(make_state()) is None


# --------------------------------------------------------------------- subsets


def test_naked_pair() -> None:
    state = make_state({rc(1, 1): "12", rc(1, 2): "12"})
    step = naked_pair(state)
    assert elims(step) == sorted((rc(1, c), d) for c in range(3, 10) for d in (1, 2))
    assert step is not None
    assert step.cells == [rc(1, 1), rc(1, 2)]


def test_hidden_pair() -> None:
    state = make_state(remove={1: list(ROWS[0][2:]), 2: list(ROWS[0][2:])})
    step = hidden_pair(state)
    assert elims(step) == sorted((rc(1, c), d) for c in (1, 2) for d in range(3, 10))


def test_naked_triple() -> None:
    state = make_state({rc(1, 1): "12", rc(1, 2): "23", rc(1, 3): "13"})
    step = naked_triple(state)
    assert elims(step) == sorted((rc(1, c), d) for c in range(4, 10) for d in (1, 2, 3))


def test_hidden_triple() -> None:
    others = list(ROWS[0][3:])
    state = make_state(remove={1: others, 2: others, 3: others})
    step = hidden_triple(state)
    assert elims(step) == sorted((rc(1, c), d) for c in (1, 2, 3) for d in range(4, 10))


def test_naked_quad() -> None:
    state = make_state({rc(1, 1): "12", rc(1, 2): "23", rc(1, 3): "34", rc(1, 4): "14"})
    step = naked_quad(state)
    assert elims(step) == sorted((rc(1, c), d) for c in range(5, 10) for d in (1, 2, 3, 4))


def test_hidden_quad() -> None:
    others = list(ROWS[0][4:])
    state = make_state(remove={1: others, 2: others, 3: others, 4: others})
    step = hidden_quad(state)
    assert elims(step) == sorted((rc(1, c), d) for c in (1, 2, 3, 4) for d in range(5, 10))


def test_subsets_none() -> None:
    state = make_state()
    for finder in (naked_pair, hidden_pair, naked_triple, hidden_triple, naked_quad, hidden_quad):
        assert finder(state) is None


# ------------------------------------------------------------------------ fish


def _fish_state(rows_to_cols: dict[int, tuple[int, ...]], digit: int = 5) -> State:
    remove = [rc(r, c) for r, cols in rows_to_cols.items() for c in range(1, 10) if c not in cols]
    return make_state(remove={digit: remove})


def test_x_wing() -> None:
    state = _fish_state({1: (2, 7), 4: (2, 7)})
    step = x_wing(state)
    expected = sorted((rc(r, c), 5) for c in (2, 7) for r in range(1, 10) if r not in (1, 4))
    assert elims(step) == expected
    assert step is not None
    assert step.cells == [rc(1, 2), rc(1, 7), rc(4, 2), rc(4, 7)]
    assert "rows 1, 4" in step.explanation
    assert "columns 2, 7" in step.explanation


def test_x_wing_column_based() -> None:
    remove = [rc(r, c) for c in (3, 8) for r in range(1, 10) if r not in (2, 6)]
    state = make_state(remove={4: remove})
    expected = sorted((rc(r, c), 4) for r in (2, 6) for c in range(1, 10) if c not in (3, 8))
    assert elims(x_wing(state)) == expected


def test_swordfish() -> None:
    state = _fish_state({1: (1, 5), 4: (5, 9), 7: (1, 9)})
    assert x_wing(state) is None
    expected = sorted((rc(r, c), 5) for c in (1, 5, 9) for r in range(1, 10) if r not in (1, 4, 7))
    assert elims(swordfish(state)) == expected


def test_jellyfish() -> None:
    state = _fish_state({1: (1, 3), 3: (3, 5), 5: (5, 7), 7: (7, 1)})
    assert x_wing(state) is None
    assert swordfish(state) is None
    expected = sorted(
        (rc(r, c), 5) for c in (1, 3, 5, 7) for r in range(1, 10) if r not in (1, 3, 5, 7)
    )
    assert elims(jellyfish(state)) == expected


def test_fish_none() -> None:
    state = make_state()
    assert x_wing(state) is None
    assert swordfish(state) is None
    assert jellyfish(state) is None


# ----------------------------------------------------------------------- wings


def test_xy_wing() -> None:
    state = make_state({rc(1, 1): "12", rc(1, 5): "13", rc(5, 1): "23"})
    step = xy_wing(state)
    assert elims(step) == [(rc(5, 5), 3)]
    assert step is not None
    assert step.cells == [rc(1, 1), rc(1, 5), rc(5, 1)]


def test_xyz_wing() -> None:
    state = make_state({rc(1, 1): "123", rc(1, 5): "13", rc(2, 2): "23"})
    assert xy_wing(state) is None
    step = xyz_wing(state)
    assert elims(step) == [(rc(1, 2), 3), (rc(1, 3), 3)]


def test_w_wing() -> None:
    remove = {1: [rc(9, c) for c in range(2, 9)]}
    state = make_state({rc(1, 1): "12", rc(5, 9): "12"}, remove)
    step = w_wing(state)
    assert elims(step) == [(rc(1, 9), 2), (rc(5, 1), 2)]
    assert step is not None
    assert set(step.cells) == {rc(1, 1), rc(5, 9), rc(9, 1), rc(9, 9)}


def test_wings_none() -> None:
    state = make_state()
    assert xy_wing(state) is None
    assert xyz_wing(state) is None
    assert w_wing(state) is None
    # Same bivalue cells but no strong link: no W-Wing.
    assert w_wing(make_state({rc(1, 1): "12", rc(5, 9): "12"})) is None


# ---------------------------------------------------------------------- chains


def _coloring_remove(extra_col2: bool) -> dict[int, list[int]]:
    cells = [rc(1, c) for c in range(1, 10) if c not in (1, 5)]
    cells += [rc(r, 5) for r in range(1, 10) if r not in (1, 4)]
    cells += [rc(4, c) for c in range(1, 10) if c not in (2, 5)]
    if extra_col2:
        cells += [rc(r, 2) for r in range(1, 10) if r not in (2, 4)]
    return {5: cells}


def test_simple_coloring_trap() -> None:
    state = make_state(remove=_coloring_remove(extra_col2=False))
    step = simple_coloring(state)
    assert elims(step) == sorted([(rc(2, 2), 5), (rc(3, 2), 5), (rc(5, 1), 5), (rc(6, 1), 5)])
    assert step is not None
    assert "see cells of both colours" in step.explanation


def test_simple_coloring_wrap() -> None:
    state = make_state(remove=_coloring_remove(extra_col2=True))
    step = simple_coloring(state)
    assert elims(step) == sorted([(rc(1, 1), 5), (rc(2, 2), 5), (rc(4, 5), 5)])
    assert step is not None
    assert "see each other" in step.explanation


def test_x_chain() -> None:
    remove = [rc(1, c) for c in range(2, 10) if c != 5]
    remove += [rc(r, 6) for r in range(1, 10) if r not in (2, 7)]
    state = make_state(remove={5: remove})
    step = x_chain(state)
    assert elims(step) == [(rc(7, 1), 5)]
    assert step is not None
    assert "r1c1=r1c5-r2c6=r7c6" in step.explanation


def test_xy_chain() -> None:
    state = make_state(
        {rc(1, 1): "12", rc(1, 5): "23", rc(5, 5): "34", rc(5, 9): "14"},
    )
    assert xy_wing(state) is None
    step = xy_chain(state)
    assert elims(step) == [(rc(1, 9), 1), (rc(5, 1), 1)]
    assert step is not None
    assert step.cells == [rc(1, 1), rc(1, 5), rc(5, 5), rc(5, 9)]
    assert "r1c1(1=2)-r1c5(2=3)-r5c5(3=4)-r5c9(4=1)" in step.explanation


def test_chains_none() -> None:
    state = make_state()
    assert simple_coloring(state) is None
    assert x_chain(state) is None
    assert xy_chain(state) is None
    assert forcing_chain(state) is None


def test_forcing_chain_contradiction() -> None:
    # r1c1 is 1 or 2. If r1c1 = 1 then r1c2 (only 1/3) = 3 and r1c3 (only 1/3)
    # has no candidate left: contradiction, so r1c1 = 2.
    state = make_state({rc(1, 1): "12", rc(1, 2): "13", rc(1, 3): "13"})
    step = forcing_chain(state)
    assert step is not None
    assert step.placements == [(rc(1, 1), 2)]
    assert "contradiction" in step.explanation


def test_forcing_chain_common_conclusion() -> None:
    grid = parse(TECHNIQUE_PUZZLES["Forcing Chain"])
    solution = solve(grid)
    assert solution is not None
    state = State.from_grid(grid)
    seen = False
    while not state.solved:
        step = find_step(state)
        assert step is not None
        if step.technique == "Forcing Chain":
            seen = True
            assert all(solution[c] == d for c, d in step.placements)
            assert all(solution[c] != d for c, d in step.eliminations)
        state = state.apply(step)
    assert seen


# ------------------------------------------------------------------ uniqueness


def test_unique_rectangle_type1() -> None:
    state = make_state(
        {rc(1, 1): "12", rc(1, 4): "12", rc(2, 1): "12", rc(2, 4): "125"},
    )
    step = unique_rectangle(state)
    assert elims(step) == [(rc(2, 4), 1), (rc(2, 4), 2)]
    assert step is not None
    assert "(type 1)" in step.explanation


def test_unique_rectangle_type2() -> None:
    state = make_state(
        {rc(1, 1): "12", rc(1, 4): "12", rc(2, 1): "127", rc(2, 4): "127"},
    )
    step = unique_rectangle(state)
    assert elims(step) == [(rc(2, c), 7) for c in (2, 3, 5, 6, 7, 8, 9)]
    assert step is not None
    assert "(type 2)" in step.explanation


def test_unique_rectangle_column_orientation() -> None:
    state = make_state(
        {rc(1, 1): "12", rc(4, 1): "12", rc(1, 2): "12", rc(4, 2): "123"},
    )
    assert elims(unique_rectangle(state)) == [(rc(4, 2), 1), (rc(4, 2), 2)]


def test_unique_rectangle_needs_two_boxes() -> None:
    # Four boxes: not a deadly pattern.
    state = make_state(
        {rc(1, 1): "12", rc(1, 4): "12", rc(4, 1): "12", rc(4, 4): "125"},
    )
    assert unique_rectangle(state) is None


# ------------------------------------------------------------------------- ALS


def test_als_xz() -> None:
    state = make_state({rc(1, 1): "12", rc(5, 1): "13", rc(6, 1): "23"})
    step = als_xz(state)
    assert elims(step) == [(rc(r, 1), 2) for r in (2, 3, 4, 7, 8, 9)]
    assert step is not None
    assert "almost locked sets" in step.explanation


def test_als_none() -> None:
    assert als_xz(make_state()) is None


# --------------------------------------------------------- puzzle-level checks


def test_registry_order_is_level_then_weight() -> None:
    names = [name for name, _ in TECHNIQUES]
    assert names == list(TECHNIQUE_WEIGHTS)
    keys = [(TECHNIQUE_LEVEL[n].rank, TECHNIQUE_WEIGHTS[n]) for n in names]
    assert keys == sorted(keys)


@pytest.mark.parametrize("technique", sorted(TECHNIQUE_PUZZLES))
def test_reference_puzzle_uses_technique(technique: str) -> None:
    grid = parse(TECHNIQUE_PUZZLES[technique])
    solution = solve(grid)
    rating = rate(grid)
    assert rating.solved_logically
    assert technique in rating.techniques
    for step in rating.steps:
        assert all(solution is not None and solution[c] == d for c, d in step.placements)
        assert all(solution is not None and solution[c] != d for c, d in step.eliminations)
        assert step.placements or step.eliminations
        assert step.explanation.startswith(step.technique)


def test_sudokuwiki_xwing_example() -> None:
    rating = rate(parse(CLASSIC["sudokuwiki_xwing"]))
    assert rating.techniques.get("X-Wing") == 1
