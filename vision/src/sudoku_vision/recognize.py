"""Top-level pipeline: decode -> grid -> cells -> classifier -> correction."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Final

import numpy as np

from . import cells as cells_mod
from .classifier import predict
from .correct import correct_givens
from .decode import decode_image
from .grid import detect_grid, grid_score, quad_area
from .types import CellKind, CellReading, Recognition, RecognitionError

NO_GRID_SCORE: Final = 0.5  # below this grid score there is no Sudoku grid
EMPTY_PROB: Final = 0.5  # model "no digit" probability that makes a cell empty


def recognize(image: bytes, *, corners: Sequence[tuple[float, float]] | None = None) -> Recognition:
    """Recognise the Sudoku in *image* (jpeg, png or webp bytes).

    Args:
        image: The encoded image. Never written anywhere.
        corners: Optional grid corners TL, TR, BR, BL in pixels of the
            EXIF-oriented input image; skips grid detection.

    Raises:
        RecognitionError: ``image_too_large``, ``unsupported_image``,
            ``image_unreadable`` or ``no_grid_found``.
        ValueError: *corners* is not four finite points spanning a real area.
    """
    return recognize_detailed(image, corners=corners)[0]


def recognize_detailed(
    image: bytes, *, corners: Sequence[tuple[float, float]] | None = None
) -> tuple[Recognition, tuple[CellReading, ...]]:
    """Like :func:`recognize`, plus the cell readings *before* correction.

    Internal (benchmarks and tests); not part of the public API.
    """
    decoded = decode_image(image)
    warnings: list[str] = []
    if corners is not None:
        quad = _parse_corners(corners)
        work = (np.array(quad, np.float64) * decoded.scale).astype(np.float32)
        score = grid_score(decoded.gray, work)
        if score < NO_GRID_SCORE:
            warnings.append("the corners do not outline a Sudoku grid clearly")
        out_corners = quad
    else:
        found = detect_grid(decoded.gray)
        if found is None or found[1] < NO_GRID_SCORE:
            raise RecognitionError("no_grid_found", "no Sudoku grid was found in the image")
        work, score = found
        out_corners = tuple(
            (round(float(x) / decoded.scale, 2), round(float(y) / decoded.scale, 2))
            for x, y in work
        )

    feats = cells_mod.extract(decoded.gray, work)
    raw = _classify(feats)
    readings, fix_warnings = correct_givens(raw)
    warnings.extend(fix_warnings)
    result = Recognition(
        corners=out_corners,
        image_size=decoded.size,
        cells=readings,
        grid_confidence=round(float(score), 4),
        warnings=tuple(warnings),
    )
    return result, raw


def _parse_corners(corners: Sequence[tuple[float, float]]) -> tuple[tuple[float, float], ...]:
    try:
        quad = np.array([[float(x), float(y)] for x, y in corners], dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("corners must be four (x, y) pairs") from exc
    if quad.shape != (4, 2) or not np.all(np.isfinite(quad)):
        raise ValueError("corners must be four finite (x, y) pairs")
    if quad_area(quad.astype(np.float32)) < 100.0:
        raise ValueError("corners must span an area")
    return tuple((float(x), float(y)) for x, y in quad)


def _classify(feats: list[cells_mod.CellFeatures]) -> tuple[CellReading, ...]:
    todo = [i for i, f in enumerate(feats) if not f.empty]
    batch = np.zeros((len(todo), 2, cells_mod.INPUT, cells_mod.INPUT), np.float32)
    for k, i in enumerate(todo):
        batch[k] = feats[i].x
    pred = predict(batch)
    out: list[CellReading] = []
    for i, f in enumerate(feats):
        if f.empty:
            conf = 1.0 - min(0.5, f.ink / cells_mod.MIN_INK_FRACTION / 2)
            out.append(CellReading(i, 0, "empty", round(conf, 4), (), False))
            continue
        k = todo.index(i)
        p = pred.digit[k].astype(np.float64)
        digits = p[1:]
        if p[0] >= EMPTY_PROB:  # the model sees no digit (smudge, shadow edge)
            out.append(CellReading(i, 0, "empty", _r(p[0]), (), False))
            continue
        q = digits / max(float(digits.sum()), 1e-9)
        top = np.argsort(-q)[:3]
        alts = tuple((int(d) + 1, _r(q[d])) for d in top)
        p_given = float(pred.kind[k][0])
        kind: CellKind = "given" if p_given >= 0.5 else "handwritten"
        conf = float(q[top[0]]) * max(p_given, 1.0 - p_given)
        out.append(CellReading(i, int(top[0]) + 1, kind, _r(conf), alts, False))
    return tuple(out)


def _r(v: float) -> float:
    x = round(float(v), 4)
    return 0.0 if math.isnan(x) else x
