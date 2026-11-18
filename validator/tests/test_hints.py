from __future__ import annotations

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from sudoku_validator import Grid, find_errors, next_hint, parse, solve
from sudoku_validator.logical_solver import iter_steps
from sudoku_validator.state import State

from .reference import CLASSIC, LEVEL_PUZZLES

WIKI = parse(CLASSIC["wikipedia"])
WIKI_SOL = solve(WIKI)
assert WIKI_SOL is not None


def with_values(grid: Grid, changes: dict[int, int]) -> Grid:
    cells = list(grid)
    for i, v in changes.items():
        cells[i] = v
    return tuple(cells)


def first_empty(grid: Grid, n: int = 1) -> list[int]:
    return [i for i, v in enumerate(grid) if v == 0][:n]


def wrong(i: int) -> int:
    assert WIKI_SOL is not None
    return WIKI_SOL[i] % 9 + 1


# ---------------------------------------------------------------- find_errors


def test_find_errors() -> None:
    assert WIKI_SOL is not None
    assert find_errors(WIKI, WIKI_SOL) == []
    a, b = first_empty(WIKI, 2)
    current = with_values(WIKI, {a: wrong(a), b: WIKI_SOL[b]})
    assert find_errors(current, WIKI_SOL) == [a]
    assert find_errors(with_values(WIKI, {a: 42}), WIKI_SOL) == [a]
    with pytest.raises(ValueError, match="current"):
        find_errors((0,) * 80, WIKI_SOL)
    with pytest.raises(ValueError, match="solution"):
        find_errors(WIKI, (0,) * 3)


# ------------------------------------------------------------------ error hints


def test_error_hint_single() -> None:
    assert WIKI_SOL is not None
    (a,) = first_empty(WIKI)
    hint = next_hint(WIKI, with_values(WIKI, {a: wrong(a)}), WIKI_SOL)
    assert hint is not None
    assert hint.kind == "error"
    assert hint.cells == [a]
    assert hint.technique is None
    assert hint.value is None
    assert hint.explanation == "r1c3 is incorrect."


def test_error_hint_several() -> None:
    assert WIKI_SOL is not None
    cells = first_empty(WIKI, 5)
    two = next_hint(WIKI, with_values(WIKI, {c: wrong(c) for c in cells[:2]}), WIKI_SOL)
    assert two is not None
    assert two.explanation == "r1c3 and r1c4 are incorrect."
    five = next_hint(WIKI, with_values(WIKI, {c: wrong(c) for c in cells}), WIKI_SOL)
    assert five is not None
    assert five.cells == cells
    assert five.explanation.startswith("5 cells are incorrect: r1c3")


def test_changed_given_and_garbage_are_errors() -> None:
    assert WIKI_SOL is not None
    hint = next_hint(WIKI, with_values(WIKI, {0: 9}), WIKI_SOL)
    assert hint is not None
    assert hint.kind == "error"
    assert hint.cells == [0]
    hint = next_hint(WIKI, with_values(WIKI, {2: 17, 3: -1}), WIKI_SOL)
    assert hint is not None
    assert hint.kind == "error"
    assert hint.cells == [2, 3]


# ------------------------------------------------------------------- step hints


def test_complete_board_has_no_hint() -> None:
    assert WIKI_SOL is not None
    assert next_hint(WIKI, WIKI_SOL, WIKI_SOL) is None


def test_erased_given_is_restored() -> None:
    assert WIKI_SOL is not None
    current = with_values(WIKI_SOL, {0: 0})  # given r1c1 erased, everything else filled
    assert next_hint(WIKI, current, WIKI_SOL) is None


def test_step_hint_from_start() -> None:
    assert WIKI_SOL is not None
    hint = next_hint(WIKI, WIKI, WIKI_SOL)
    assert hint is not None
    assert hint.kind == "step"
    assert hint.technique == "Naked Single"
    assert hint.value == WIKI_SOL[hint.cells[0]]
    assert "Naked Single" in hint.explanation


def _state_needing(puzzle: str) -> tuple[Grid, Grid, str]:
    """Board right before the first non-single step of *puzzle*."""
    grid = parse(puzzle)
    sol = solve(grid)
    assert sol is not None
    state = State.from_grid(grid)
    for step, after in iter_steps(state):
        if step.technique not in ("Naked Single", "Hidden Single"):
            return state.values, sol, step.technique
        state = after
    raise AssertionError("puzzle never needs an advanced step")


def test_elimination_hint_looks_ahead_to_placement() -> None:
    current, sol, technique = _state_needing(LEVEL_PUZZLES["hard"])
    givens = parse(LEVEL_PUZZLES["hard"])
    hint = next_hint(givens, current, sol)
    assert hint is not None
    assert hint.kind == "step"
    assert hint.technique == technique
    assert hint.value is not None
    assert current[hint.cells[0]] == 0
    assert hint.value == sol[hint.cells[0]]
    assert "This leads to" in hint.explanation or "further deduction" in hint.explanation


def test_reveal_when_no_logical_step() -> None:
    givens = parse(CLASSIC["easter_monster"])
    sol = solve(givens)
    assert sol is not None
    hint = next_hint(givens, givens, sol)
    assert hint is not None
    assert hint.kind == "step"
    assert hint.technique is None
    assert hint.value == sol[hint.cells[0]]
    assert "No simple logical step" in hint.explanation


def test_bad_solution_is_recomputed() -> None:
    assert WIKI_SOL is not None
    expected = next_hint(WIKI, WIKI, WIKI_SOL)
    for bogus in [(0,) * 81, (5,) * 81, with_values(WIKI_SOL, {0: 3}), tuple(range(81))]:
        assert next_hint(WIKI, WIKI, bogus) == expected


def test_unusable_givens_give_no_hint() -> None:
    dup = parse("11" + "." * 79)
    assert next_hint(dup, dup, (0,) * 81) is None
    garbage = (99,) * 81
    assert next_hint(garbage, garbage, garbage) is None


def test_wrong_length_raises() -> None:
    with pytest.raises(ValueError, match="givens"):
        next_hint((0,) * 80, WIKI, WIKI)
    with pytest.raises(ValueError, match="current"):
        next_hint(WIKI, (0,) * 82, WIKI)
    with pytest.raises(ValueError, match="solution"):
        next_hint(WIKI, WIKI, ())


# ------------------------------------------------------------------- properties

cell_values = st.integers(min_value=-3, max_value=12)
any_grid = st.lists(cell_values, min_size=81, max_size=81).map(tuple)


@settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(current=any_grid, givens_choice=st.sampled_from(["wiki", "garbage"]))
def test_next_hint_never_crashes(current: Grid, givens_choice: str) -> None:
    assert WIKI_SOL is not None
    givens = WIKI if givens_choice == "wiki" else current
    hint = next_hint(givens, current, WIKI_SOL)
    assert hint is None or hint.kind in ("error", "step")


@settings(max_examples=40, deadline=None)
@given(
    puzzle=st.sampled_from(sorted(LEVEL_PUZZLES.values())),
    keep=st.lists(st.booleans(), min_size=81, max_size=81),
)
def test_hint_on_correct_partial_board(puzzle: str, keep: list[bool]) -> None:
    givens = parse(puzzle)
    sol = solve(givens)
    assert sol is not None
    current = tuple(g or (s if k else 0) for g, s, k in zip(givens, sol, keep, strict=True))
    hint = next_hint(givens, current, sol)
    if all(current):
        assert hint is None
        return
    assert hint is not None
    assert hint.kind == "step"
    if hint.value is not None:
        assert current[hint.cells[0]] == 0
        assert hint.value == sol[hint.cells[0]]


# ------------------------------------------------- defensive paths (monkeypatched)


def test_inconsistent_step_falls_back_to_reveal(monkeypatch: pytest.MonkeyPatch) -> None:
    from sudoku_validator import hints
    from sudoku_validator.step import Step

    assert WIKI_SOL is not None
    (cell,) = first_empty(WIKI)
    bogus = Step("Naked Single", [(cell, wrong(cell))], [], [cell], "bogus")

    def fake_iter(state: State, *, allow_uniqueness: bool = True) -> object:
        yield bogus, state

    monkeypatch.setattr(hints, "iter_steps", fake_iter)
    hint = next_hint(WIKI, WIKI, WIKI_SOL)
    assert hint is not None
    assert hint.technique is None
    assert hint.value == WIKI_SOL[hint.cells[0]]


def test_elimination_without_follow_up(monkeypatch: pytest.MonkeyPatch) -> None:
    from sudoku_validator import hints
    from sudoku_validator.step import Step

    assert WIKI_SOL is not None
    (cell,) = first_empty(WIKI)
    elim = Step("X-Wing", [], [(cell, wrong(cell))], [cell, 0], "X-Wing: test.")

    def fake_iter(state: State, *, allow_uniqueness: bool = True) -> object:
        yield elim, state

    monkeypatch.setattr(hints, "iter_steps", fake_iter)
    hint = next_hint(WIKI, WIKI, WIKI_SOL)
    assert hint is not None
    assert hint.technique == "X-Wing"
    assert hint.value is None
    assert hint.cells == [cell, 0]
