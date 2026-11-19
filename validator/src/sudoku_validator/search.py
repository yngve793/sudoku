"""Constraint-only checks for search mode (what-if exploration trees).

:func:`find_contradiction` and :func:`propagate` run on arbitrary player boards,
including wrong ones. They never solve the puzzle or consult a solution: the
only information used is the digits already on the board.

Candidates here are always the *basic* candidates: every digit not already
placed in a peer of the cell. No technique eliminations are applied, so the
frontend can reproduce the same semantics cheaply.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal

from .grid import SIZE, UNIT_NAMES, UNITS, Grid, cell_name, is_well_formed, require_len
from .state import ALL, BIT, DIGITS_OF, State
from .techniques.base import HIDDEN_SINGLE, NAKED_SINGLE
from .techniques.singles import hidden_single, naked_single

ContradictionKind = Literal["duplicate", "no_candidates", "digit_nowhere"]
PropagationTechnique = Literal["Naked Single", "Hidden Single"]

_TIMES: Final = {2: "twice", 3: "three times"}


@dataclass(frozen=True)
class Contradiction:
    """A constraint violation on a board.

    Attributes:
        kind: ``duplicate``, ``no_candidates`` or ``digit_nowhere``.
        cells: Cells involved: the cells holding the duplicated digit, the
            single empty cell, or the empty cells of the unit (ascending).
        digit: The digit for ``duplicate`` / ``digit_nowhere``, else ``None``.
        unit: ``"row 3"`` / ``"column 5"`` / ``"box 2"`` (1-based), ``None``
            for ``no_candidates``.
        explanation: Human-readable explanation using ``rXcY`` notation.
    """

    kind: ContradictionKind
    cells: tuple[int, ...]
    digit: int | None
    unit: str | None
    explanation: str


@dataclass(frozen=True)
class Placement:
    """One implied placement and the technique that found it."""

    cell: int
    value: int
    technique: PropagationTechnique


@dataclass(frozen=True)
class Propagation:
    """Result of :func:`propagate`.

    Attributes:
        placements: Placements in the order they were found.
        contradiction: The first contradiction found (it stops propagation).
        grid: The resulting grid (input plus every placement).
    """

    placements: tuple[Placement, ...]
    contradiction: Contradiction | None
    grid: Grid


def _checked(grid: Sequence[int]) -> Grid:
    require_len(grid)
    if not is_well_formed(grid):
        raise ValueError("grid must contain 81 ints in 0..9")
    return tuple(grid)


def _duplicate(grid: Grid) -> Contradiction | None:
    for u, unit in enumerate(UNITS):
        seen = dup = 0
        for c in unit:
            bit = BIT[grid[c]]
            dup |= seen & bit
            seen |= bit
        dup &= ALL
        if dup:
            d = DIGITS_OF[dup][0]
            cells = tuple(c for c in unit if grid[c] == d)
            names = ", ".join(cell_name(c) for c in cells)
            times = _TIMES.get(len(cells), f"{len(cells)} times")
            return Contradiction(
                kind="duplicate",
                cells=cells,
                digit=d,
                unit=UNIT_NAMES[u],
                explanation=f"{d} appears {times} in {UNIT_NAMES[u]} ({names}).",
            )
    return None


def _no_candidates(grid: Grid, cands: Sequence[int]) -> Contradiction | None:
    for i in range(SIZE):
        if grid[i] == 0 and cands[i] == 0:
            name = cell_name(i)
            return Contradiction(
                kind="no_candidates",
                cells=(i,),
                digit=None,
                unit=None,
                explanation=(
                    f"No digit can go in {name}: every digit from 1 to 9 already "
                    f"appears in its row, column or box."
                ),
            )
    return None


def _digit_nowhere(grid: Grid, cands: Sequence[int]) -> Contradiction | None:
    for u, unit in enumerate(UNITS):
        covered = 0
        for c in unit:
            covered |= cands[c] | BIT[grid[c]]
        missing = ALL & ~covered
        if missing:
            d = DIGITS_OF[missing][0]
            cells = tuple(c for c in unit if grid[c] == 0)
            name = UNIT_NAMES[u]
            return Contradiction(
                kind="digit_nowhere",
                cells=cells,
                digit=d,
                unit=name,
                explanation=(
                    f"{d} cannot be placed anywhere in {name}: it is missing there, "
                    f"but every empty cell of {name} already sees a {d}."
                ),
            )
    return None


def _contradiction(grid: Grid, cands: Sequence[int]) -> Contradiction | None:
    return _duplicate(grid) or _no_candidates(grid, cands) or _digit_nowhere(grid, cands)


def find_contradiction(grid: Grid) -> Contradiction | None:
    """Return the first constraint violation on *grid*, or ``None``.

    Kinds are checked in this order: ``duplicate``, ``no_candidates``,
    ``digit_nowhere``. Within a kind:

    * ``duplicate``: units in order rows 1-9, columns 1-9, boxes 1-9; within a
      unit the lowest duplicated digit.
    * ``no_candidates``: cells in row-major order (r1c1, r1c2, ...). Candidates
      are the digits not placed in any peer.
    * ``digit_nowhere``: units in the same order as ``duplicate``; within a
      unit the lowest digit that is not placed and has no candidate cell.

    Constraint-only: never consults a solution. Raises :class:`ValueError` if
    the grid does not have 81 cells or holds a value outside ``0..9``.
    """
    g = _checked(grid)
    return _contradiction(g, State.from_grid(g).cands)


def propagate(grid: Grid, *, max_placements: int = 81) -> Propagation:
    """Apply naked and hidden singles until nothing changes.

    Stops when no single remains, when *max_placements* placements were made,
    or as soon as a contradiction appears (checked after every placement; the
    placement that caused it is included). An already contradictory grid
    returns no placements and its contradiction.

    The order is deterministic: at each step the first naked single in
    row-major cell order is placed; if there is none, the first hidden single
    scanning boxes 1-9, then rows 1-9, then columns 1-9 (lowest digit first
    within a unit). This is the same order as the hint engine.

    Constraint-only: never consults a solution. Raises :class:`ValueError` if
    the grid is malformed or *max_placements* is negative.
    """
    g = _checked(grid)
    if max_placements < 0:
        raise ValueError("max_placements must be >= 0")
    state = State.from_grid(g)
    contradiction = _contradiction(g, state.cands)
    placements: list[Placement] = []
    while contradiction is None and len(placements) < max_placements:
        step = naked_single(state)
        technique: PropagationTechnique = NAKED_SINGLE
        if step is None:
            step = hidden_single(state)
            technique = HIDDEN_SINGLE
            if step is None:
                break
        cell, value = step.placements[0]
        placements.append(Placement(cell, value, technique))
        state = state.apply(step)
        # A single always places a candidate, so it cannot create a duplicate;
        # the cheap is_broken() test covers the two remaining kinds.
        if state.is_broken():
            contradiction = _contradiction(state.values, state.cands)
    return Propagation(tuple(placements), contradiction, state.values)


__all__ = [
    "Contradiction",
    "ContradictionKind",
    "Placement",
    "Propagation",
    "PropagationTechnique",
    "find_contradiction",
    "propagate",
]
