"""Hand-built boards for the contradiction checks.

Each case is ``(name, grid, intent)`` where *intent* is ``None`` (no
contradiction) or ``(kind, unit)`` describing what the board was built to
show. ``fixtures/contradictions.json`` is generated from these cases with
``uv run python validator/tests/contradiction_cases.py``; the test-suite checks
that the JSON, the intents and :func:`find_contradiction` all agree.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Final

if __name__ == "__main__":  # pragma: no cover - fixture generation only
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sudoku_validator import Grid, find_contradiction, format_grid, parse

FIXTURE: Final = Path(__file__).parent / "fixtures" / "contradictions.json"

SOLVED: Final = parse(
    "534678912672195348198342567859761423426853791713924856961537284287419635345286179"
)
WIKIPEDIA: Final = parse(
    "53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79"
)


def board(*entries: tuple[int, int, int], base: Grid | None = None) -> Grid:
    """Build a grid from ``(row, col, digit)`` triples (1-based rows/cols)."""
    cells = list(base if base is not None else (0,) * 81)
    for r, c, d in entries:
        cells[(r - 1) * 9 + (c - 1)] = d
    return tuple(cells)


def row(r: int, digits: str, base: Grid | None = None) -> Grid:
    """Set row *r* (1-based) from a 9-char string (``0`` keeps the cell empty)."""
    return board(*((r, c + 1, int(ch)) for c, ch in enumerate(digits)), base=base)


def transpose(grid: Grid) -> Grid:
    return tuple(grid[(i % 9) * 9 + i // 9] for i in range(81))


Intent = tuple[str, str | None] | None

#: r1c1 sees 1-8 in row 1 and 9 in column 1 (row 1 also has nowhere for 9).
NO_CANDIDATES: Final = board((5, 1, 9), base=row(1, "012345678"))
#: Row 1 is 0 0 0 1 2 3 4 6 7 and box 1 has a 5 in r2c1: 5 fits nowhere in row 1.
_ROW_NOWHERE: Final = board((2, 1, 5), base=row(1, "000123467"))
#: Box 1 is missing 5 and 9; r1c1 and r2c2 both see a 5 outside the box.
_BOX_NOWHERE: Final = board(
    (1, 2, 1),
    (1, 3, 2),
    (2, 1, 3),
    (2, 3, 4),
    (3, 1, 6),
    (3, 2, 7),
    (3, 3, 8),
    (1, 5, 5),
    (5, 2, 5),
)

CASES: Final[list[tuple[str, Grid, Intent]]] = [
    ("empty grid", (0,) * 81, None),
    ("valid puzzle", WIKIPEDIA, None),
    ("solved grid", SOLVED, None),
    (
        "wrong digit without a visible contradiction",
        board((1, 3, 2), base=WIKIPEDIA),
        None,
    ),
    ("duplicate in row", board((1, 1, 5), (1, 9, 5)), ("duplicate", "row 1")),
    ("duplicate in column", board((2, 4, 7), (8, 4, 7)), ("duplicate", "column 4")),
    ("duplicate in box", board((4, 4, 3), (6, 6, 3)), ("duplicate", "box 5")),
    (
        "digit three times in a row",
        board((9, 1, 8), (9, 5, 8), (9, 9, 8)),
        ("duplicate", "row 9"),
    ),
    (
        "row duplicate reported before column duplicate",
        board((9, 1, 2), (1, 1, 2), (5, 3, 6), (5, 8, 6)),
        ("duplicate", "row 5"),
    ),
    (
        "lowest duplicated digit in the unit first",
        board((3, 1, 9), (3, 2, 4), (3, 8, 9), (3, 9, 4)),
        ("duplicate", "row 3"),
    ),
    (
        "duplicate reported before no candidates",
        board((7, 7, 1), (7, 8, 1), base=NO_CANDIDATES),
        ("duplicate", "row 7"),
    ),
    (
        "swapped digits in a solved grid",
        board((1, 1, 3), (1, 2, 5), base=SOLVED),
        ("duplicate", "column 1"),
    ),
    (
        "no candidates reported before digit nowhere",
        NO_CANDIDATES,
        ("no_candidates", None),
    ),
    (
        "first cell without candidates in row-major order",
        board((7, 9, 9), base=row(9, "123456780", base=NO_CANDIDATES)),
        ("no_candidates", None),
    ),
    ("digit nowhere in row", _ROW_NOWHERE, ("digit_nowhere", "row 1")),
    ("digit nowhere in column", transpose(_ROW_NOWHERE), ("digit_nowhere", "column 1")),
    ("digit nowhere in box", _BOX_NOWHERE, ("digit_nowhere", "box 1")),
    (
        "row digit nowhere reported before box digit nowhere",
        board((8, 1, 5), base=row(9, "000123467", base=_BOX_NOWHERE)),
        ("digit_nowhere", "row 9"),
    ),
]


def expected(grid: Grid) -> dict[str, object] | None:
    found = find_contradiction(grid)
    if found is None:
        return None
    out = asdict(found)
    out["cells"] = list(found.cells)
    return out


def fixture_data() -> list[dict[str, object]]:
    return [
        {"name": name, "grid": format_grid(grid), "expected": expected(grid)}
        for name, grid, _ in CASES
    ]


if __name__ == "__main__":  # pragma: no cover - fixture generation only
    FIXTURE.parent.mkdir(exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture_data(), indent=2) + "\n")
    print(f"wrote {len(CASES)} cases to {FIXTURE}")
