"""Unique Rectangle types 1 and 2.

These deductions are only valid for puzzles with exactly one solution; the
logical solver enables them only after uniqueness has been proven.
"""

from __future__ import annotations

from itertools import combinations

from ..grid import BOX_OF, COL_OF, PEER_BITS, ROW_OF, cell_name
from ..state import DIGITS_OF, POPCOUNT, State, iter_bits
from ..step import Step
from .base import UNIQUE_RECTANGLE, digits_str, elimination_step
from .wings import bivalue_cells


def unique_rectangle(state: State) -> Step | None:
    cands = state.cands
    values = state.values
    bivalue = bivalue_cells(state)
    for a, b in combinations(bivalue, 2):
        pm = cands[a]
        if cands[b] != pm:
            continue
        if ROW_OF[a] == ROW_OF[b]:
            others = [(r * 9 + COL_OF[a], r * 9 + COL_OF[b]) for r in range(9) if r != ROW_OF[a]]
        elif COL_OF[a] == COL_OF[b]:
            others = [(ROW_OF[a] * 9 + c, ROW_OF[b] * 9 + c) for c in range(9) if c != COL_OF[a]]
        else:
            continue
        for c, d in others:
            if len({BOX_OF[a], BOX_OF[b], BOX_OF[c], BOX_OF[d]}) != 2:
                continue
            if values[c] or values[d] or cands[c] & pm != pm or cands[d] & pm != pm:
                continue
            step = _type1(state, pm, a, b, c, d) or _type2(state, pm, a, b, c, d)
            if step is not None:
                return step
    return None


def _describe(pm: int, cells: tuple[int, ...]) -> str:
    names = ", ".join(cell_name(c) for c in cells)
    return (
        f"{names} form a rectangle over two boxes with candidates {digits_str(DIGITS_OF[pm])}; "
        f"if these four cells held only those digits the puzzle would have two solutions."
    )


def _type1(state: State, pm: int, a: int, b: int, c: int, d: int) -> Step | None:
    cands = state.cands
    for floor, roof in ((c, d), (d, c)):
        if cands[floor] == pm and cands[roof] != pm:
            elims = [(roof, x) for x in DIGITS_OF[pm]]
            return elimination_step(
                UNIQUE_RECTANGLE,
                elims,
                [a, b, floor, roof],
                f"(type 1) {_describe(pm, (a, b, c, d))} Only {cell_name(roof)} has extra "
                f"candidates, so it cannot be {digits_str(DIGITS_OF[pm])}.",
            )
    return None


def _type2(state: State, pm: int, a: int, b: int, c: int, d: int) -> Step | None:
    cands = state.cands
    if cands[c] != cands[d] or POPCOUNT[cands[c]] != 3:
        return None
    z = DIGITS_OF[cands[c] & ~pm][0]
    targets = [t for t in iter_bits(PEER_BITS[c] & PEER_BITS[d]) if cands[t] & (1 << z)]
    if not targets:
        return None
    return elimination_step(
        UNIQUE_RECTANGLE,
        [(t, z) for t in targets],
        [a, b, c, d],
        f"(type 2) {_describe(pm, (a, b, c, d))} So {z} must be in {cell_name(c)} or "
        f"{cell_name(d)}, and cells seeing both cannot be {z}.",
    )
