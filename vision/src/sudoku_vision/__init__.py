"""sudoku_vision: recognize a Sudoku grid in a photo (see PLAN.md §5.6).

The result types import cheaply (no OpenCV, onnxruntime, Pillow or numpy), so a
process that only unpickles :class:`Recognition` or catches
:class:`RecognitionError` never loads the image stack. ``recognize`` is imported
lazily on first access (PEP 562).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .types import CellKind, CellReading, ErrorCode, Recognition, RecognitionError

if TYPE_CHECKING:
    from .recognize import recognize

__all__ = [
    "CellKind",
    "CellReading",
    "ErrorCode",
    "Recognition",
    "RecognitionError",
    "recognize",
]


def __getattr__(name: str) -> Any:
    if name == "recognize":
        from .recognize import recognize

        globals()["recognize"] = recognize
        return recognize
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
