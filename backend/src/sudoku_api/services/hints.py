"""Staged hint disclosure on top of `sudoku_validator.next_hint`.

* Stage 1: the technique and a region (one row, column or box). `cells` holds all cells of
  that region. No value, no pattern cells, and the text has no cell names or candidate digits.
* Stage 2: the exact cells (target first when there is a value) and the validator's
  explanation, with the value redacted.
* Stage 3: everything, including the value.

Error hints: stage 1 only says that there is a mistake; stage 2 and 3 name the wrong cells.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from sudoku_api.services import puzzle_logic
from sudoku_api.services.scoring import hint_cost

UNIT_KINDS = ("box", "row", "column")  # order breaks ties when choosing a region

# The validator's "look-ahead" hints append the placement they unlock to the explanation,
# e.g. "<X-Wing ...> This leads to: Hidden Single: ... so r3c5 = 7."
_FOLLOW_UP = re.compile(r"\s*(?:This leads to: |After \d+ further deduction\(s\): ).*\Z", re.DOTALL)
_NO_ARTICLE = frozenset({"Locked Candidates", "Simple Coloring"})


@dataclass(frozen=True)
class StagedHint:
    kind: Literal["error", "step"]
    stage: int
    technique: str | None
    cells: list[int]
    value: int | None
    explanation: str
    penalty: int


def unit_cells(kind: str, index: int) -> list[int]:
    """Cells of row/column/box `index` (0-based)."""
    if kind == "row":
        return [index * 9 + c for c in range(9)]
    if kind == "column":
        return [r * 9 + index for r in range(9)]
    br, bc = divmod(index, 3)
    return [(br * 3 + dr) * 9 + bc * 3 + dc for dr in range(3) for dc in range(3)]


def choose_region(cells: list[int]) -> tuple[str, int, list[int]]:
    """The row, column or box of `cells[0]` that contains the most hint cells."""
    anchor = cells[0]
    row, col = divmod(anchor, 9)
    indices = {"box": (row // 3) * 3 + col // 3, "row": row, "column": col}
    hint_cells = set(cells)
    best = max(
        UNIT_KINDS,
        key=lambda k: (len(hint_cells & set(unit_cells(k, indices[k]))), -UNIT_KINDS.index(k)),
    )
    return best, indices[best], unit_cells(best, indices[best])


def _with_article(technique: str) -> str:
    if technique in _NO_ARTICLE:
        return technique
    return f"{'an' if technique[0] in 'AEIOX' else 'a'} {technique}"


def redact_value(explanation: str, target: int, value: int) -> str:
    """Remove the look-ahead tail and every mention of `value` as a digit.

    Unit numbers ("row 4", "box 4"), "(type 1)" and counts like "3 cells" are kept;
    cell names such as r4c5 are never touched because the digit is not a separate word.
    """
    text = _FOLLOW_UP.sub(
        f" This unlocks the value of {puzzle_logic.cell_name(target)}.", explanation
    )
    pattern = re.compile(
        rf"(?<!row )(?<!rows )(?<!column )(?<!columns )(?<!box )(?<!type )"
        rf"\b{value}\b(?! cells| further)"
    )
    return pattern.sub("?", text)


def stage_hint(hint: puzzle_logic.Hint, stage: int) -> StagedHint:
    penalty = hint_cost(stage)
    if hint.kind == "error":
        if stage == 1:
            text = "Your board contains a mistake."
            return StagedHint("error", stage, None, [], None, text, penalty)
        return StagedHint("error", stage, None, list(hint.cells), None, hint.explanation, penalty)

    if not hint.cells:  # defensive: the validator always returns cells for a step
        return StagedHint("step", stage, hint.technique, [], None, hint.explanation, penalty)

    if stage == 1:
        kind, index, region = choose_region(hint.cells)
        where = f"{kind} {index + 1}"
        text = (
            f"Try {_with_article(hint.technique)} in {where}."
            if hint.technique
            else f"No simple technique applies here; look closely at {where}."
        )
        return StagedHint("step", stage, hint.technique, region, None, text, penalty)

    if stage == 2:
        text = (
            hint.explanation
            if hint.value is None
            else redact_value(hint.explanation, hint.cells[0], hint.value)
        )
        return StagedHint("step", stage, hint.technique, list(hint.cells), None, text, penalty)

    return StagedHint(
        "step", stage, hint.technique, list(hint.cells), hint.value, hint.explanation, penalty
    )
