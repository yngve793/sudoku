"""Straightened grid -> 81 cell tiles -> classifier inputs.

Steps (shared by inference and training so both see identical inputs):

1. :func:`straighten`: perspective warp to a square of ``9 * CELL`` pixels and
   normalise lighting into an *ink* image (0 = paper, 1 = darkest ink).
2. :func:`find_intersections`: locate the 10 x 10 line intersections locally,
   which absorbs mild page curvature and corner error (the "de-curving" pass).
3. :func:`cell_tiles`: warp each cell quad to a ``TILE`` x ``TILE`` tile.
4. :func:`cell_features`: remove grid-line remnants and border-touching blobs,
   decide emptiness from the remaining ink, and build the two 32 x 32 input
   channels (digit crop scaled to a fixed size, and the whole cell).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import cv2
import numpy as np
import numpy.typing as npt

from .grid import FloatArray, U8Array, warp

CELL: Final = 48  # cell size in the straightened image
TILE: Final = 48  # cell tile size
INPUT: Final = 32  # classifier input size
INK_THRESHOLD: Final = 0.2  # normalised ink level counted as a stroke
MIN_INK_FRACTION: Final = 0.012  # less stroke area than this (of the tile) means empty
MIN_HEIGHT_FRACTION: Final = 0.22  # digit bbox must be at least this tall (of the tile)
DIGIT_BOX: Final = 22  # digit crop is scaled so its long side is this many pixels

F32 = npt.NDArray[np.float32]


@dataclass(frozen=True)
class CellFeatures:
    """Classifier input for one cell.

    Attributes:
        empty: True if too little ink remains after cleaning.
        ink: Fraction of the tile covered by digit strokes.
        x: ``(2, INPUT, INPUT)`` float32 input: channel 0 is the digit crop at a
            fixed scale and contrast, channel 1 the cleaned whole cell.
    """

    empty: bool
    ink: float
    x: F32


def straighten(gray: U8Array, corners: FloatArray) -> F32:
    """Warp the grid to a ``9*CELL`` square and return its normalised ink image."""
    side = 9 * CELL
    big = warp(gray, corners, side * 2)
    sq = cv2.resize(big, (side, side), interpolation=cv2.INTER_AREA).astype(np.float32)
    # Paper estimate: a grayscale closing removes thin dark strokes; blur smooths it.
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    bg = cv2.morphologyEx(sq, cv2.MORPH_CLOSE, k)
    bg = cv2.GaussianBlur(bg, (0, 0), 6)
    ink = np.clip(1.0 - sq / np.maximum(bg, 1.0), 0.0, 1.0)
    top = float(np.percentile(ink, 99.5))
    ink = np.clip(ink / max(top, 0.25), 0.0, 1.0)
    return np.asarray(ink, dtype=np.float32)


def find_intersections(ink: F32) -> FloatArray:
    """(10, 10, 2) array of (x, y) line intersections, refined locally."""
    side = ink.shape[0]
    s = side / 9.0
    binary = (ink > 0.3).astype(np.uint8)
    k = int(s * 0.7)
    horiz = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((1, k), np.uint8)).astype(np.float32)
    vert = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((k, 1), np.uint8)).astype(np.float32)
    r = int(s * 0.3)
    half = int(s * 0.6)
    pts = np.zeros((10, 10, 2), np.float32)
    for i in range(10):  # horizontal line index (y)
        for j in range(10):  # vertical line index (x)
            ex, ey = j * s, i * s
            pts[i, j] = (
                _line_pos(vert, ex, ey, r, half, axis=1),
                _line_pos(horiz, ey, ex, r, half, axis=0),
            )
    return _regularise(pts, s)


def _line_pos(mask: F32, expected: float, along: float, r: int, half: int, axis: int) -> float:
    """Position of the line nearest *expected* in a window centred at *along*."""
    n = mask.shape[0]
    lo, hi = max(0, round(expected) - r), min(n, round(expected) + r + 1)
    a0, a1 = max(0, round(along) - half), min(n, round(along) + half + 1)
    win = mask[lo:hi, a0:a1] if axis == 0 else mask[a0:a1, lo:hi]
    prof = win.sum(axis=1 - axis) if axis == 0 else win.sum(axis=0)
    total = float(prof.sum())
    if total < 0.25 * (a1 - a0):
        return expected
    peak = int(np.argmax(prof))
    w0, w1 = max(0, peak - 3), min(len(prof), peak + 4)
    idx = np.arange(w0, w1, dtype=np.float32)
    weights = prof[w0:w1]
    return float(lo + (idx * weights).sum() / max(float(weights.sum()), 1e-6))


def _regularise(pts: FloatArray, s: float) -> FloatArray:
    """Replace intersections that disagree with what their neighbours predict."""
    out = pts.copy()
    for i in range(10):
        for j in range(10):
            preds = [
                pts[a, b] + np.array([(j - b) * s, (i - a) * s], np.float32)
                for a, b in ((i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1))
                if 0 <= a < 10 and 0 <= b < 10
            ]
            pred = np.median(np.array(preds), axis=0)
            if float(np.linalg.norm(pts[i, j] - pred)) > s * 0.15:
                out[i, j] = pred
    return out


def cell_tiles(ink: F32, pts: FloatArray) -> F32:
    """(81, TILE, TILE) ink tiles, one per cell, row-major."""
    dst = np.array([[0, 0], [TILE, 0], [TILE, TILE], [0, TILE]], np.float32)
    tiles = np.zeros((81, TILE, TILE), np.float32)
    for r in range(9):
        for c in range(9):
            src = np.array([pts[r, c], pts[r, c + 1], pts[r + 1, c + 1], pts[r + 1, c]], np.float32)
            m = cv2.getPerspectiveTransform(src, dst)
            tiles[r * 9 + c] = cv2.warpPerspective(
                ink, m, (TILE, TILE), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT
            )
    return tiles


def cell_features(tile: F32) -> CellFeatures:
    """Clean one tile and build its classifier input."""
    t = tile.copy()
    inset = max(1, round(TILE * 0.06))
    t[:inset, :] = 0
    t[-inset:, :] = 0
    t[:, :inset] = 0
    t[:, -inset:] = 0
    binary = (t > INK_THRESHOLD).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    keep = np.zeros(n, bool)
    lo, hi = inset + 1, TILE - inset - 2
    c0, c1 = int(TILE * 0.28), int(TILE * 0.72)
    min_blob = max(4, int(TILE * TILE * 0.002))
    for i in range(1, n):
        bx, by, bw, bh, blob = (int(v) for v in stats[i])
        if blob < min_blob:
            continue
        touches = bx <= lo or by <= lo or bx + bw - 1 >= hi or by + bh - 1 >= hi
        central = int((labels[c0:c1, c0:c1] == i).sum())
        if touches and central < max(3, blob * 0.08):
            continue  # a grid-line remnant or a blob creeping in from a neighbour
        if not touches and central == 0 and blob < TILE * TILE * 0.01:
            continue  # a speck away from the centre
        keep[i] = True
    mask = keep[labels]
    area = int(mask.sum())
    ink_frac = area / float(TILE * TILE)
    x = np.zeros((2, INPUT, INPUT), np.float32)
    if area == 0:
        return CellFeatures(empty=True, ink=0.0, x=x)
    ys, xs = np.nonzero(mask)
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
    empty = ink_frac < MIN_INK_FRACTION or (y1 - y0) < TILE * MIN_HEIGHT_FRACTION
    soft = cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    clean = np.where(soft, t, 0.0).astype(np.float32)
    # Channel 0: digit crop, long side DIGIT_BOX, centred.
    crop = clean[y0:y1, x0:x1]
    f = DIGIT_BOX / max(y1 - y0, x1 - x0)
    cw, ch = max(1, round((x1 - x0) * f)), max(1, round((y1 - y0) * f))
    small = cv2.resize(crop, (cw, ch), interpolation=cv2.INTER_AREA)
    ox, oy = (INPUT - cw) // 2, (INPUT - ch) // 2
    x[0, oy : oy + ch, ox : ox + cw] = small
    # Channel 1: whole cell (keeps size and position, useful for the kind).
    x[1] = cv2.resize(clean, (INPUT, INPUT), interpolation=cv2.INTER_AREA)
    peak = float(x[0].max())
    if peak > 0:
        x[0] /= peak  # shape channel is contrast-normalised; channel 1 keeps ink darkness
    return CellFeatures(empty=empty, ink=ink_frac, x=x)


def extract(gray: U8Array, corners: FloatArray) -> list[CellFeatures]:
    """Full cell stage: straighten, refine intersections, tile, featurise."""
    ink = straighten(gray, corners)
    pts = find_intersections(ink)
    tiles = cell_tiles(ink, pts)
    return [cell_features(t) for t in tiles]
