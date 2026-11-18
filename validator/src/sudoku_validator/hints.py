"""Hints for an in-progress board: :func:`find_errors` and :func:`next_hint`."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

from .grid import (
    SIZE,
    Grid,
    cell_name,
    is_complete_solution,
    is_consistent,
    is_digit_value,
    is_well_formed,
    require_len,
)
from .logical_solver import iter_steps
from .solver import count_solutions, solve
from .state import BIT, POPCOUNT, State
from .step import Step

#: How many follow-up steps an elimination hint may look ahead for a placement.
_MAX_LOOKAHEAD: Final = 40


@dataclass(frozen=True)
class Hint:
    """A hint for the player.

    * ``kind="error"``: ``cells`` are the wrong entries, ``technique`` and
      ``value`` are ``None``.
    * ``kind="step"``: ``technique`` names the logical technique (``None`` if
      no logical step was found and a cell is simply revealed). If ``value`` is
      not ``None``, ``cells[0]`` is the cell that receives it and the remaining
      cells are the pattern to highlight.
    """

    kind: Literal["error", "step"]
    technique: str | None
    cells: list[int]
    value: int | None
    explanation: str


def find_errors(current: Grid, solution: Grid) -> list[int]:
    """Indices of filled cells in *current* that differ from *solution*.

    Cells holding anything other than an int in 0..9 also count as errors.
    Raises :class:`ValueError` if either grid does not have 81 cells.
    """
    require_len(current, "current")
    require_len(solution, "solution")
    errors: list[int] = []
    for i in range(SIZE):
        v = current[i]
        if not is_digit_value(v) or (v != 0 and v != solution[i]):
            errors.append(i)
    return errors


def _trusted_solution(givens: Grid, solution: Grid) -> Grid | None:
    givens_ok = is_well_formed(givens)
    if (
        givens_ok
        and is_complete_solution(solution)
        and all(g == 0 or g == s for g, s in zip(givens, solution, strict=True))
    ):
        return tuple(solution)
    if givens_ok and is_consistent(givens):
        return solve(givens)
    return None


def _error_hint(errors: list[int]) -> Hint:
    names = [cell_name(i) for i in errors]
    if len(names) == 1:
        text = f"{names[0]} is incorrect."
    elif len(names) <= 3:
        text = f"{', '.join(names[:-1])} and {names[-1]} are incorrect."
    else:
        text = f"{len(names)} cells are incorrect: {', '.join(names)}."
    return Hint("error", None, list(errors), None, text)


def next_hint(givens: Grid, current: Grid, solution: Grid) -> Hint | None:
    """Return the next hint for *current*, or ``None`` if the board is complete.

    1. Wrong entries (including changed givens and out-of-range values) are
       reported first as an ``error`` hint.
    2. Otherwise the easiest logical step from the current board is returned.
       If that step only removes candidates, the solver looks ahead to the
       first placement it unlocks so the hint always leads to progress.
    3. If no logical step exists, the most constrained cell is revealed.

    Never raises for 81-cell inputs, whatever their contents; raises
    :class:`ValueError` if any grid does not have 81 cells. If *solution* is
    not a valid solution of *givens* it is recomputed from *givens*; if that is
    impossible ``None`` is returned.
    """
    require_len(givens, "givens")
    require_len(current, "current")
    require_len(solution, "solution")
    sol = _trusted_solution(givens, solution)
    if sol is None:
        return None
    errors = find_errors(current, sol)
    if errors:
        return _error_hint(errors)
    work = tuple(givens[i] or current[i] for i in range(SIZE))
    if all(work):
        return None
    return _logical_hint(work, sol)


def _consistent_with(step: Step, solution: Grid) -> bool:
    return all(solution[c] == d for c, d in step.placements) and all(
        solution[c] != d for c, d in step.eliminations
    )


def _logical_hint(work: Grid, sol: Grid) -> Hint:
    state = State.from_grid(work)
    unique = count_solutions(work, 2) == 1
    first: Step | None = None
    for n, (step, _) in enumerate(iter_steps(state, allow_uniqueness=unique)):
        if not _consistent_with(step, sol) or n > _MAX_LOOKAHEAD:
            break
        if first is None:
            first = step
        if step.placements:
            cell, value = step.placements[0]
            if step is first:
                return Hint(
                    "step",
                    step.technique,
                    [cell, *(c for c in step.cells if c != cell)],
                    value,
                    step.explanation,
                )
            follow = (
                "This leads to: " if n == 1 else f"After {n - 1} further deduction(s): "
            ) + step.explanation
            return Hint(
                "step",
                first.technique,
                [cell, *(c for c in first.cells if c != cell)],
                value,
                f"{first.explanation} {follow}",
            )
    if first is not None:
        return Hint("step", first.technique, list(first.cells), None, first.explanation)
    return _reveal_hint(state, sol)


def _reveal_hint(state: State, sol: Grid) -> Hint:
    empty = [i for i in range(SIZE) if state.values[i] == 0]
    cell = min(empty, key=lambda i: (POPCOUNT[state.cands[i]] or 10, i))
    value = sol[cell]
    note = "" if state.cands[cell] & BIT[value] else " (check your other entries)"
    return Hint(
        "step",
        None,
        [cell],
        value,
        f"No simple logical step is available here; {cell_name(cell)} = {value}{note}.",
    )
