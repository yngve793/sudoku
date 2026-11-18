"""The :class:`Step` result type produced by every logical technique."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Step:
    """One logical deduction.

    Attributes:
        technique: Technique name, a key of ``TECHNIQUE_WEIGHTS``.
        placements: ``(cell, digit)`` pairs that are now known.
        eliminations: ``(cell, digit)`` candidates that are ruled out.
        cells: Cells forming the pattern, to highlight in the UI.
        explanation: Human-readable explanation using ``rXcY`` notation.
    """

    technique: str
    placements: list[tuple[int, int]]
    eliminations: list[tuple[int, int]]
    cells: list[int]
    explanation: str
