"""ALS-XZ (Almost Locked Set, restricted common candidate X, eliminated digit Z)."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Final

from ..grid import PEER_BITS, UNIT_NAMES, UNITS
from ..state import DIGITS_OF, POPCOUNT, State, iter_bits
from ..step import Step
from .base import ALS_XZ, cells_str, digits_str, elimination_step

#: Largest ALS (in cells) that is enumerated; bounds the search.
MAX_ALS_SIZE: Final = 4

_ALL_CELLS: Final = (1 << 81) - 1


@dataclass(frozen=True, slots=True)
class _Als:
    unit: int
    cells: tuple[int, ...]
    bits: int
    mask: int
    #: For each digit of ``mask``: cells of the ALS holding it.
    digit_bits: dict[int, int]
    #: For each digit of ``mask``: cells (outside the ALS) seeing all its cells holding it.
    seen_by: dict[int, int]


def _find_als(state: State) -> list[_Als]:
    values, cands = state.values, state.cands
    found: dict[int, _Als] = {}
    for u, unit in enumerate(UNITS):
        empties = [c for c in unit if values[c] == 0]
        for size in range(1, min(MAX_ALS_SIZE, len(empties) - 1) + 1):
            for combo in combinations(empties, size):
                mask = 0
                for c in combo:
                    mask |= cands[c]
                if POPCOUNT[mask] != size + 1:
                    continue
                bits = sum(1 << c for c in combo)
                if bits in found:
                    continue
                digit_bits: dict[int, int] = {}
                seen_by: dict[int, int] = {}
                for d in DIGITS_OF[mask]:
                    db = 0
                    seen = _ALL_CELLS
                    for c in combo:
                        if cands[c] & (1 << d):
                            db |= 1 << c
                            seen &= PEER_BITS[c]
                    digit_bits[d] = db
                    seen_by[d] = seen & ~bits
                found[bits] = _Als(u, combo, bits, mask, digit_bits, seen_by)
    return list(found.values())


def als_xz(state: State) -> Step | None:
    digit_cells = state.digit_cells()
    alss = _find_als(state)
    for a, b in combinations(alss, 2):
        if a.bits & b.bits:
            continue
        common = a.mask & b.mask
        if POPCOUNT[common] < 2:
            continue
        digits = DIGITS_OF[common]
        for x in digits:
            # X is restricted common: every X in A sees every X in B.
            if b.digit_bits[x] & ~a.seen_by[x]:
                continue
            for z in digits:
                if z == x:
                    continue
                targets = a.seen_by[z] & b.seen_by[z] & digit_cells[z] & ~(a.bits | b.bits)
                if not targets:
                    continue
                tl = list(iter_bits(targets))
                return elimination_step(
                    ALS_XZ,
                    [(t, z) for t in tl],
                    [*a.cells, *b.cells],
                    f"{cells_str(a.cells)} in {UNIT_NAMES[a.unit]} "
                    f"({digits_str(DIGITS_OF[a.mask])}) and {cells_str(b.cells)} in "
                    f"{UNIT_NAMES[b.unit]} ({digits_str(DIGITS_OF[b.mask])}) are almost locked "
                    f"sets. {x} cannot be in both (every {x} of one sees every {x} of the "
                    f"other), so one of them is locked and {z} must be in one of them.",
                )
    return None
