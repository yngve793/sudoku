"""Naked single and hidden single."""

from __future__ import annotations

from typing import Final

from ..grid import SIZE, UNIT_NAMES, UNITS, cell_name
from ..state import BIT, DIGITS_OF, POPCOUNT, State
from ..step import Step
from .base import HIDDEN_SINGLE, NAKED_SINGLE, make_step

#: Boxes first (easiest to scan for humans), then rows, then columns.
_HIDDEN_ORDER: Final = tuple(range(18, 27)) + tuple(range(9)) + tuple(range(9, 18))


def naked_single(state: State) -> Step | None:
    """A cell with exactly one remaining candidate."""
    values, cands = state.values, state.cands
    for i in range(SIZE):
        m = cands[i]
        if values[i] == 0 and POPCOUNT[m] == 1:
            d = DIGITS_OF[m][0]
            name = cell_name(i)
            return make_step(
                NAKED_SINGLE,
                placements=[(i, d)],
                cells=[i],
                explanation=(
                    f"Naked Single: every digit except {d} already appears in the row, "
                    f"column or box of {name}, so {name} = {d}."
                ),
            )
    return None


def hidden_single(state: State) -> Step | None:
    """A digit that has only one possible cell in some unit."""
    cands = state.cands
    for u in _HIDDEN_ORDER:
        unit = UNITS[u]
        once = twice = 0
        for c in unit:
            m = cands[c]
            twice |= once & m
            once |= m
        only = once & ~twice
        if not only:
            continue
        d = DIGITS_OF[only][0]
        bit = BIT[d]
        cell = next(c for c in unit if cands[c] & bit)
        name = cell_name(cell)
        return make_step(
            HIDDEN_SINGLE,
            placements=[(cell, d)],
            cells=[cell, *unit],
            explanation=(
                f"Hidden Single: in {UNIT_NAMES[u]}, {d} can only go in {name}, so {name} = {d}."
            ),
        )
    return None
