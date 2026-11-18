"""Technique names, weights and shared formatting helpers."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from types import MappingProxyType
from typing import Final

from ..grid import cell_name
from ..state import State
from ..step import Step

Finder = Callable[[State], Step | None]

NAKED_SINGLE: Final = "Naked Single"
HIDDEN_SINGLE: Final = "Hidden Single"
LOCKED_CANDIDATES: Final = "Locked Candidates"
NAKED_PAIR: Final = "Naked Pair"
HIDDEN_PAIR: Final = "Hidden Pair"
NAKED_TRIPLE: Final = "Naked Triple"
HIDDEN_TRIPLE: Final = "Hidden Triple"
X_WING: Final = "X-Wing"
NAKED_QUAD: Final = "Naked Quad"
HIDDEN_QUAD: Final = "Hidden Quad"
SWORDFISH: Final = "Swordfish"
XY_WING: Final = "XY-Wing"
XYZ_WING: Final = "XYZ-Wing"
JELLYFISH: Final = "Jellyfish"
SIMPLE_COLORING: Final = "Simple Coloring"
X_CHAIN: Final = "X-Chain"
W_WING: Final = "W-Wing"
UNIQUE_RECTANGLE: Final = "Unique Rectangle"
XY_CHAIN: Final = "XY-Chain"
ALS_XZ: Final = "ALS-XZ"
FORCING_CHAIN: Final = "Forcing Chain"

#: Rating weight per technique (PLAN.md section 4), in solver order (level, then weight).
TECHNIQUE_WEIGHTS: Final = MappingProxyType(
    {
        NAKED_SINGLE: 1,
        HIDDEN_SINGLE: 2,
        LOCKED_CANDIDATES: 5,
        NAKED_PAIR: 8,
        HIDDEN_PAIR: 10,
        NAKED_TRIPLE: 15,
        HIDDEN_TRIPLE: 18,
        X_WING: 25,
        XY_WING: 40,
        NAKED_QUAD: 30,
        HIDDEN_QUAD: 30,
        SWORDFISH: 40,
        XYZ_WING: 50,
        SIMPLE_COLORING: 60,
        X_CHAIN: 60,
        W_WING: 65,
        JELLYFISH: 60,
        UNIQUE_RECTANGLE: 70,
        XY_CHAIN: 90,
        ALS_XZ: 110,
        FORCING_CHAIN: 150,
    }
)


def cells_str(cells: Iterable[int]) -> str:
    return ", ".join(cell_name(c) for c in cells)


def digits_str(digits: Iterable[int]) -> str:
    return "/".join(str(d) for d in digits)


def elims_str(eliminations: Iterable[tuple[int, int]]) -> str:
    """Group eliminations by digit: ``"3 from r1c7, r1c9; 8 from r1c9"``."""
    by_digit: dict[int, list[int]] = {}
    for cell, digit in eliminations:
        by_digit.setdefault(digit, []).append(cell)
    return "; ".join(f"{d} from {cells_str(sorted(cs))}" for d, cs in sorted(by_digit.items()))


def make_step(
    technique: str,
    *,
    placements: Iterable[tuple[int, int]] = (),
    eliminations: Iterable[tuple[int, int]] = (),
    cells: Iterable[int] = (),
    explanation: str,
) -> Step:
    """Build a :class:`Step` with de-duplicated, sorted placements/eliminations."""
    return Step(
        technique=technique,
        placements=sorted(set(placements)),
        eliminations=sorted(set(eliminations)),
        cells=list(dict.fromkeys(cells)),
        explanation=explanation,
    )


def elimination_step(
    technique: str, eliminations: list[tuple[int, int]], cells: Iterable[int], reason: str
) -> Step:
    """An elimination-only step whose explanation ends with the removed candidates."""
    elims = sorted(set(eliminations))
    return make_step(
        technique,
        eliminations=elims,
        cells=cells,
        explanation=f"{technique}: {reason} Remove {elims_str(elims)}.",
    )
