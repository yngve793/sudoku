"""Public result types of :func:`sudoku_vision.recognize` (PLAN.md §5.6)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

CellKind = Literal["empty", "given", "handwritten"]
ErrorCode = Literal["image_unreadable", "unsupported_image", "image_too_large", "no_grid_found"]


@dataclass(frozen=True)
class CellReading:
    """What was read in one cell.

    Attributes:
        index: Cell index 0..80, row-major.
        digit: 1..9, or 0 for an empty cell.
        kind: ``empty``, ``given`` (printed) or ``handwritten``.
        confidence: 0..1, how sure the reader is about ``digit`` *and* ``kind``.
        alternatives: Top-3 ``(digit, probability)`` pairs, best first; always
            ``()`` when ``kind == "empty"``.
        auto_corrected: True if constraint-assisted correction changed this given.
    """

    index: int
    digit: int
    kind: CellKind
    confidence: float
    alternatives: tuple[tuple[int, float], ...]
    auto_corrected: bool


@dataclass(frozen=True)
class Recognition:
    """The recognised puzzle.

    Attributes:
        corners: Grid corners TL, TR, BR, BL in pixels of the oriented input image.
        image_size: ``(width, height)`` of the oriented input image.
        cells: 81 readings, row-major.
        grid_confidence: 0..1, how grid-like the straightened image looks.
        warnings: Human-readable notes, e.g. ``"givens have multiple solutions"``.
    """

    corners: tuple[tuple[float, float], ...]
    image_size: tuple[int, int]
    cells: tuple[CellReading, ...]
    grid_confidence: float
    warnings: tuple[str, ...]


class RecognitionError(Exception):
    """Recognition failed; ``code`` says why (maps to an HTTP status in the backend)."""

    code: ErrorCode

    def __init__(self, code: ErrorCode, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code

    def __reduce__(self) -> tuple[type[RecognitionError], tuple[ErrorCode, str]]:
        # Keeps ``code`` across pickling (the backend runs recognition in worker processes).
        return (type(self), (self.code, str(self)))
