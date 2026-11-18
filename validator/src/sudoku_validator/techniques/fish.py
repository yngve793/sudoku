"""Basic fish: X-Wing (2), Swordfish (3), Jellyfish (4)."""

from __future__ import annotations

from itertools import combinations

from ..grid import COLS, ROWS
from ..state import BIT, POPCOUNT, State, iter_bits
from ..step import Step
from .base import JELLYFISH, SWORDFISH, X_WING, elimination_step


def _fish(state: State, n: int, name: str) -> Step | None:
    cands = state.cands
    for d in range(1, 10):
        bit = BIT[d]
        for base_lines, cover_lines, base_kind, cover_kind in (
            (ROWS, COLS, "rows", "columns"),
            (COLS, ROWS, "columns", "rows"),
        ):
            lines: list[tuple[int, int]] = []
            for li, line in enumerate(base_lines):
                pos = 0
                for k, c in enumerate(line):
                    if cands[c] & bit:
                        pos |= 1 << k
                if 2 <= POPCOUNT[pos] <= n:
                    lines.append((li, pos))
            if len(lines) < n:
                continue
            for combo in combinations(lines, n):
                cover = 0
                for _, pos in combo:
                    cover |= pos
                if POPCOUNT[cover] != n:
                    continue
                base_idx = {li for li, _ in combo}
                cover_idx = list(iter_bits(cover))
                elims = [
                    (c, d)
                    for ci in cover_idx
                    for k, c in enumerate(cover_lines[ci])
                    if k not in base_idx and cands[c] & bit
                ]
                if not elims:
                    continue
                pattern = [c for li, _ in combo for c in base_lines[li] if cands[c] & bit]
                bases = ", ".join(str(li + 1) for li, _ in combo)
                covers = ", ".join(str(ci + 1) for ci in cover_idx)
                return elimination_step(
                    name,
                    elims,
                    pattern,
                    f"in {base_kind} {bases}, {d} is only possible in {cover_kind} {covers}, "
                    f"so {d} must occupy those {cover_kind} within {base_kind} {bases}.",
                )
    return None


def x_wing(state: State) -> Step | None:
    return _fish(state, 2, X_WING)


def swordfish(state: State) -> Step | None:
    return _fish(state, 3, SWORDFISH)


def jellyfish(state: State) -> Step | None:
    return _fish(state, 4, JELLYFISH)
