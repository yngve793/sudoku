"""Locked candidates: pointing (box -> line) and claiming (line -> box)."""

from __future__ import annotations

from ..grid import BOX_OF, BOXES, COL_OF, COLS, ROW_OF, ROWS, UNIT_NAMES, UNITS
from ..state import BIT, State
from ..step import Step
from .base import LOCKED_CANDIDATES, cells_str, elimination_step


def locked_candidates(state: State) -> Step | None:
    """Pointing first, then claiming."""
    return _pointing(state) or _claiming(state)


def _pointing(state: State) -> Step | None:
    cands = state.cands
    for b in range(9):
        box = BOXES[b]
        for d in range(1, 10):
            bit = BIT[d]
            cells = [c for c in box if cands[c] & bit]
            if len(cells) < 2:
                continue
            for line_of, lines, offset in ((ROW_OF, ROWS, 0), (COL_OF, COLS, 9)):
                idx = line_of[cells[0]]
                if any(line_of[c] != idx for c in cells[1:]):
                    continue
                elims = [(c, d) for c in lines[idx] if BOX_OF[c] != b and cands[c] & bit]
                if elims:
                    line = UNIT_NAMES[offset + idx]
                    return elimination_step(
                        LOCKED_CANDIDATES,
                        elims,
                        cells,
                        f"(pointing) in box {b + 1}, {d} is only possible in {line} "
                        f"({cells_str(cells)}), so it cannot appear elsewhere in {line}.",
                    )
    return None


def _claiming(state: State) -> Step | None:
    cands = state.cands
    for u in range(18):
        unit = UNITS[u]
        for d in range(1, 10):
            bit = BIT[d]
            cells = [c for c in unit if cands[c] & bit]
            if len(cells) < 2:
                continue
            b = BOX_OF[cells[0]]
            if any(BOX_OF[c] != b for c in cells[1:]):
                continue
            members = set(unit)
            elims = [(c, d) for c in BOXES[b] if c not in members and cands[c] & bit]
            if elims:
                return elimination_step(
                    LOCKED_CANDIDATES,
                    elims,
                    cells,
                    f"(claiming) in {UNIT_NAMES[u]}, {d} is only possible in box {b + 1} "
                    f"({cells_str(cells)}), so it cannot appear elsewhere in box {b + 1}.",
                )
    return None
