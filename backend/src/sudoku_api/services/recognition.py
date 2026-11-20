"""Adapter over `sudoku_vision` (PLAN.md §5.6). The only module that imports it.

`sudoku_vision` (OpenCV, onnxruntime, Pillow: ~43 MB) is imported lazily inside the worker
job, and the job converts its result to backend-local dataclasses of built-ins
(`RecognitionResult`) before returning. Unpickling the result in the API process therefore
never imports `sudoku_vision`. Keep it that way: never return a `sudoku_vision` object.

Privacy: image bytes are only held in memory. They are never written, logged or included in
an error message. Failures are logged by code and exception type only.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, NamedTuple

from sudoku_api.errors import ApiError
from sudoku_api.services.generation import JobError, JobTimeoutError, PuzzleGenerator

if TYPE_CHECKING:
    from sudoku_vision import Recognition

logger = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 10 * 1024 * 1024

RecognitionErrorCode = Literal[
    "image_unreadable", "unsupported_image", "image_too_large", "no_grid_found"
]

# HTTP status for each `sudoku_vision.RecognitionError.code`.
RECOGNITION_ERROR_STATUS: dict[str, int] = {
    "image_too_large": 413,
    "unsupported_image": 415,
    "image_unreadable": 422,
    "no_grid_found": 422,
}
_MESSAGES: dict[str, str] = {
    "image_too_large": "The image is too large (at most 10 MB and 40 megapixels)",
    "unsupported_image": "Unsupported image type; use JPEG, PNG or WebP",
    "image_unreadable": "The image could not be decoded",
    "no_grid_found": "No Sudoku grid was found in the photo",
}

Corners = tuple[tuple[float, float], ...]


@dataclass(frozen=True, slots=True)
class RecognizedCell:
    index: int
    digit: int  # 0 = empty
    kind: str  # "empty" | "given" | "handwritten"
    confidence: float
    alternatives: tuple[tuple[int, float], ...]
    auto_corrected: bool


@dataclass(frozen=True, slots=True)
class RecognitionResult:
    """A `sudoku_vision.Recognition` as plain built-ins (safe to unpickle in the API)."""

    corners: tuple[tuple[float, float], ...]
    image_size: tuple[int, int]
    cells: tuple[RecognizedCell, ...]
    grid_confidence: float
    warnings: tuple[str, ...]


def to_result(rec: Recognition) -> RecognitionResult:
    """Copy every field into built-ins (vision may hand back numpy scalars)."""
    return RecognitionResult(
        corners=tuple((float(x), float(y)) for x, y in rec.corners),
        image_size=(int(rec.image_size[0]), int(rec.image_size[1])),
        cells=tuple(
            RecognizedCell(
                index=int(c.index),
                digit=int(c.digit),
                kind=str(c.kind),
                confidence=float(c.confidence),
                alternatives=tuple((int(d), float(p)) for d, p in c.alternatives),
                auto_corrected=bool(c.auto_corrected),
            )
            for c in rec.cells
        ),
        grid_confidence=float(rec.grid_confidence),
        warnings=tuple(str(w) for w in rec.warnings),
    )


class RecognitionFailure(NamedTuple):
    """A failed job, returned as a value (also keeps exception types out of the API)."""

    code: str  # a RecognitionErrorCode, "invalid_corners", or "internal" (unexpected)
    error_type: str  # exception class name, for logs (never the message or the image)


def vision_recognize(image: bytes, corners: Corners | None) -> Recognition:
    """The real recognizer. Tests monkeypatch this (it runs in a thread when processes=0)."""
    from sudoku_vision import recognize

    return recognize(image, corners=corners)


def recognition_job(
    image: bytes, corners: Corners | None
) -> RecognitionResult | RecognitionFailure:
    """Top-level, picklable worker job. Returns only backend-local built-in types."""
    from sudoku_vision import RecognitionError

    try:
        return to_result(vision_recognize(image, corners))
    except RecognitionError as exc:
        code = str(exc.code)
        if code not in RECOGNITION_ERROR_STATUS:
            return RecognitionFailure("internal", type(exc).__name__)
        return RecognitionFailure(code, type(exc).__name__)
    except ValueError as exc:
        # `recognize` raises ValueError for corners that are not four finite pairs or that
        # enclose zero area. Without corners a ValueError is an internal failure.
        code = "invalid_corners" if corners is not None else "internal"
        return RecognitionFailure(code, type(exc).__name__)
    except Exception as exc:
        return RecognitionFailure("internal", type(exc).__name__)


def unavailable() -> ApiError:
    return ApiError(
        503, "recognition_unavailable", "Photo recognition is unavailable, please try again"
    )


def parse_corners(raw: str | None) -> Corners | None:
    """The `corners` form field: a JSON array of four finite `[x, y]` pairs, or None."""
    import json

    if raw is None or raw.strip() == "":
        return None
    invalid = ApiError(
        422, "validation_error", "corners: expected a JSON array of four [x, y] number pairs"
    )
    try:
        value = json.loads(raw)
    except ValueError:
        raise invalid from None
    if not isinstance(value, list) or len(value) != 4:
        raise invalid
    corners: list[tuple[float, float]] = []
    for pair in value:
        if not isinstance(pair, list) or len(pair) != 2:
            raise invalid
        x, y = pair
        if any(isinstance(v, bool) or not isinstance(v, int | float) for v in (x, y)):
            raise invalid
        if not (math.isfinite(x) and math.isfinite(y)):
            raise invalid
        corners.append((float(x), float(y)))
    return tuple(corners)


async def recognize(
    runner: PuzzleGenerator,
    image: bytes,
    corners: Sequence[tuple[float, float]] | None,
    timeout: float,
) -> RecognitionResult:
    """Run recognition in the worker pool and map every failure to an `ApiError`."""
    if len(image) > MAX_IMAGE_BYTES:
        raise ApiError(413, "image_too_large", _MESSAGES["image_too_large"])
    pinned = None if corners is None else tuple((float(x), float(y)) for x, y in corners)
    try:
        result = await runner.run_job(timeout, recognition_job, image, pinned)
    except JobTimeoutError:
        logger.warning("photo recognition timed out after %s s", timeout)
        raise unavailable() from None
    except JobError:
        logger.warning("photo recognition worker failed")
        raise unavailable() from None
    if isinstance(result, RecognitionFailure):
        if result.code == "invalid_corners":
            raise ApiError(
                422,
                "validation_error",
                "corners: the four points must be finite and enclose a non-zero area",
            )
        status = RECOGNITION_ERROR_STATUS.get(result.code)
        if status is None:
            logger.error("photo recognition failed unexpectedly (%s)", result.error_type)
            raise unavailable()
        raise ApiError(status, result.code, _MESSAGES[result.code])
    return result
