"""Grid type, parsing/formatting and the static unit/peer tables.

A :data:`Grid` is a tuple of 81 ints in row-major order, ``0`` meaning empty.
Cells are addressed by index ``0..80``; humans see them as ``rXcY`` (1-based).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

Grid = tuple[int, ...]

SIZE: Final = 81

ROW_OF: Final[tuple[int, ...]] = tuple(i // 9 for i in range(SIZE))
COL_OF: Final[tuple[int, ...]] = tuple(i % 9 for i in range(SIZE))
BOX_OF: Final[tuple[int, ...]] = tuple((i // 27) * 3 + (i % 9) // 3 for i in range(SIZE))

ROWS: Final[tuple[tuple[int, ...], ...]] = tuple(
    tuple(r * 9 + c for c in range(9)) for r in range(9)
)
COLS: Final[tuple[tuple[int, ...], ...]] = tuple(
    tuple(r * 9 + c for r in range(9)) for c in range(9)
)
BOXES: Final[tuple[tuple[int, ...], ...]] = tuple(
    tuple(i for i in range(SIZE) if BOX_OF[i] == b) for b in range(9)
)
#: All 27 units: indices 0-8 are rows, 9-17 columns, 18-26 boxes.
UNITS: Final[tuple[tuple[int, ...], ...]] = ROWS + COLS + BOXES
UNIT_NAMES: Final[tuple[str, ...]] = (
    tuple(f"row {i + 1}" for i in range(9))
    + tuple(f"column {i + 1}" for i in range(9))
    + tuple(f"box {i + 1}" for i in range(9))
)
#: The three unit indices (row, column, box) of every cell.
CELL_UNITS: Final[tuple[tuple[int, int, int], ...]] = tuple(
    (ROW_OF[i], 9 + COL_OF[i], 18 + BOX_OF[i]) for i in range(SIZE)
)
#: The 20 peers of every cell (cells sharing a unit), sorted.
PEERS: Final[tuple[tuple[int, ...], ...]] = tuple(
    tuple(sorted({c for u in CELL_UNITS[i] for c in UNITS[u]} - {i})) for i in range(SIZE)
)
PEER_SETS: Final[tuple[frozenset[int], ...]] = tuple(frozenset(p) for p in PEERS)
#: Peers as 81-bit integer bitsets (bit ``i`` set = cell ``i``).
PEER_BITS: Final[tuple[int, ...]] = tuple(sum(1 << p for p in PEERS[i]) for i in range(SIZE))
UNIT_BITS: Final[tuple[int, ...]] = tuple(sum(1 << c for c in unit) for unit in UNITS)

_EMPTY_CHARS: Final = frozenset(".0")
_IGNORED_CHARS: Final = frozenset("|+-")


def cell_name(i: int) -> str:
    """Human name of a cell, e.g. ``r3c5`` (1-based)."""
    return f"r{i // 9 + 1}c{i % 9 + 1}"


def is_digit_value(v: object) -> bool:
    """True if *v* is an int in ``0..9`` (bools are rejected)."""
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 9


def is_well_formed(grid: object) -> bool:
    """True if *grid* is a sequence of exactly 81 ints in ``0..9``."""
    if not isinstance(grid, Sequence) or isinstance(grid, str) or len(grid) != SIZE:
        return False
    return all(is_digit_value(v) for v in grid)


def parse(s: str) -> Grid:
    """Parse an 81-cell puzzle string.

    Digits ``1-9`` are values, ``.`` or ``0`` are empty cells. Whitespace and the
    box-drawing characters ``| + -`` (as produced by ``format_grid(pretty=True)``)
    are ignored. Raises :class:`ValueError` for anything else.
    """
    cells: list[int] = []
    for ch in s:
        if ch.isspace() or ch in _IGNORED_CHARS:
            continue
        if ch in _EMPTY_CHARS:
            cells.append(0)
        elif "1" <= ch <= "9":
            cells.append(ord(ch) - ord("0"))
        else:
            raise ValueError(f"invalid character {ch!r} in puzzle string")
    if len(cells) != SIZE:
        raise ValueError(f"puzzle string has {len(cells)} cells, expected {SIZE}")
    return tuple(cells)


def format_grid(grid: Grid, *, empty: str = "0", pretty: bool = False) -> str:
    """Format a grid as an 81-char string (default) or a 9-line pretty board.

    *empty* is the character used for empty cells (``"0"`` matches the API
    regex ``^[0-9]{81}$``; use ``"."`` for the common human format).
    """
    if not is_well_formed(grid):
        raise ValueError("grid must contain 81 ints in 0..9")
    chars = [str(v) if v else empty for v in grid]
    if not pretty:
        return "".join(chars)
    lines: list[str] = []
    for r in range(9):
        if r and r % 3 == 0:
            lines.append("------+-------+------")
        row = chars[r * 9 : r * 9 + 9]
        lines.append(" | ".join(" ".join(row[b * 3 : b * 3 + 3]) for b in range(3)))
    return "\n".join(lines)


def is_consistent(grid: Grid) -> bool:
    """True if the grid is well formed and no unit contains a duplicate digit."""
    if not is_well_formed(grid):
        return False
    for unit in UNITS:
        seen = 0
        for c in unit:
            v = grid[c]
            if v:
                bit = 1 << v
                if seen & bit:
                    return False
                seen |= bit
    return True


def is_complete_solution(grid: Grid) -> bool:
    """True if the grid is fully filled and consistent."""
    return is_consistent(grid) and all(grid)


def require_len(grid: object, name: str = "grid") -> None:
    """Raise :class:`ValueError` unless *grid* is a sequence of 81 cells."""
    if not isinstance(grid, Sequence) or isinstance(grid, str) or len(grid) != SIZE:
        raise ValueError(f"{name} must have exactly {SIZE} cells")
