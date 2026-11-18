"""Naked and hidden subsets (pairs, triples, quads)."""

from __future__ import annotations

from itertools import combinations

from ..grid import UNIT_NAMES, UNITS
from ..state import ALL, BIT, DIGITS_OF, POPCOUNT, State, iter_bits
from ..step import Step
from .base import (
    HIDDEN_PAIR,
    HIDDEN_QUAD,
    HIDDEN_TRIPLE,
    NAKED_PAIR,
    NAKED_QUAD,
    NAKED_TRIPLE,
    cells_str,
    digits_str,
    elimination_step,
)


def _naked(state: State, n: int, name: str) -> Step | None:
    values, cands = state.values, state.cands
    for u, unit in enumerate(UNITS):
        empties = [c for c in unit if values[c] == 0]
        if len(empties) <= n:
            continue
        pool = [c for c in empties if 2 <= POPCOUNT[cands[c]] <= n]
        for combo in combinations(pool, n):
            mask = 0
            for c in combo:
                mask |= cands[c]
            if POPCOUNT[mask] != n:
                continue
            elims = [(c, d) for c in empties if c not in combo for d in DIGITS_OF[cands[c] & mask]]
            if elims:
                return elimination_step(
                    name,
                    elims,
                    combo,
                    f"in {UNIT_NAMES[u]}, {cells_str(combo)} can only contain "
                    f"{digits_str(DIGITS_OF[mask])}, so those digits are locked in these "
                    f"{n} cells.",
                )
    return None


def _hidden(state: State, n: int, name: str) -> Step | None:
    values, cands = state.values, state.cands
    for u, unit in enumerate(UNITS):
        if sum(1 for c in unit if values[c] == 0) <= n:
            continue
        positions = [0] * 10
        for k, c in enumerate(unit):
            for d in DIGITS_OF[cands[c]]:
                positions[d] |= 1 << k
        digits = [d for d in range(1, 10) if 1 <= POPCOUNT[positions[d]] <= n]
        for combo in combinations(digits, n):
            pos = 0
            keep = 0
            for d in combo:
                pos |= positions[d]
                keep |= BIT[d]
            if POPCOUNT[pos] != n:
                continue
            cells = [unit[k] for k in iter_bits(pos)]
            elims = [(c, d) for c in cells for d in DIGITS_OF[cands[c] & ~keep & ALL]]
            if elims:
                return elimination_step(
                    name,
                    elims,
                    cells,
                    f"in {UNIT_NAMES[u]}, the digits {digits_str(combo)} can only go in "
                    f"{cells_str(cells)}, so these cells cannot hold any other digit.",
                )
    return None


def naked_pair(state: State) -> Step | None:
    return _naked(state, 2, NAKED_PAIR)


def hidden_pair(state: State) -> Step | None:
    return _hidden(state, 2, HIDDEN_PAIR)


def naked_triple(state: State) -> Step | None:
    return _naked(state, 3, NAKED_TRIPLE)


def hidden_triple(state: State) -> Step | None:
    return _hidden(state, 3, HIDDEN_TRIPLE)


def naked_quad(state: State) -> Step | None:
    return _naked(state, 4, NAKED_QUAD)


def hidden_quad(state: State) -> Step | None:
    return _hidden(state, 4, HIDDEN_QUAD)
