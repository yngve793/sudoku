"""Immutable candidate state used by the logical solver and its techniques.

Candidates are stored per cell as a bitmask with bit ``d`` set for digit ``d``
(bits 1..9, so ``1 << d``). Cell sets are 81-bit Python ints.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Final

from .grid import PEERS, SIZE, UNITS, Grid
from .step import Step

ALL: Final = 0x3FE
BIT: Final[tuple[int, ...]] = tuple(1 << d for d in range(10))
POPCOUNT: Final[tuple[int, ...]] = tuple(bin(m).count("1") for m in range(1024))
DIGITS_OF: Final[tuple[tuple[int, ...], ...]] = tuple(
    tuple(d for d in range(1, 10) if m & (1 << d)) for m in range(1024)
)


def iter_bits(bits: int) -> Iterator[int]:
    """Yield the indices of the set bits of *bits* in increasing order."""
    while bits:
        low = bits & -bits
        yield low.bit_length() - 1
        bits ^= low


@dataclass(frozen=True, slots=True)
class State:
    """Placed values plus remaining candidates (``cands[i] == 0`` if placed)."""

    values: tuple[int, ...]
    cands: tuple[int, ...]

    @classmethod
    def from_grid(cls, grid: Grid) -> State:
        """Candidates are every digit not already placed in a peer."""
        cands = [0] * SIZE
        for i in range(SIZE):
            if grid[i] == 0:
                used = 0
                for p in PEERS[i]:
                    used |= BIT[grid[p]]
                cands[i] = ALL & ~used
        return cls(tuple(grid), tuple(cands))

    def apply(self, step: Step) -> State:
        values = list(self.values)
        cands = list(self.cands)
        for cell, digit in step.placements:
            values[cell] = digit
            cands[cell] = 0
            clear = ~BIT[digit]
            for p in PEERS[cell]:
                cands[p] &= clear
        for cell, digit in step.eliminations:
            cands[cell] &= ~BIT[digit]
        return State(tuple(values), tuple(cands))

    @property
    def solved(self) -> bool:
        return all(self.values)

    def is_broken(self) -> bool:
        """True if some empty cell has no candidate or a digit has no place in a unit."""
        values, cands = self.values, self.cands
        for i in range(SIZE):
            if values[i] == 0 and cands[i] == 0:
                return True
        for unit in UNITS:
            covered = 0
            for c in unit:
                covered |= cands[c] | BIT[values[c]]
            if covered & ALL != ALL:
                return True
        return False

    def digit_cells(self) -> list[int]:
        """Index ``d`` holds the bitset of cells that have candidate ``d``."""
        out = [0] * 10
        cands = self.cands
        for i in range(SIZE):
            m = cands[i]
            if m:
                bit = 1 << i
                for d in DIGITS_OF[m]:
                    out[d] |= bit
        return out
