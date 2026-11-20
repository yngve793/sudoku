"""Find the Sudoku grid: contour candidates, a Hough-line fallback, and a grid score.

All functions take and return points as float arrays of shape (4, 2) in the order
TL, TR, BR, BL.
"""

from __future__ import annotations

from typing import Final

import cv2
import numpy as np
import numpy.typing as npt

FloatArray = npt.NDArray[np.float32]
U8Array = npt.NDArray[np.uint8]

DETECT_SIDE: Final = 1000  # long side of the image used for detection
SCORE_CELL: Final = 32  # cell size of the small warp used for scoring
MIN_AREA_FRACTION: Final = 0.04  # grid must cover at least this fraction of the image
GOOD_ENOUGH: Final = 0.9  # stop trying candidates once one scores this high


def order_corners(pts: npt.ArrayLike) -> FloatArray:
    """Order four points as TL, TR, BR, BL (valid for rotations below 45 degrees)."""
    p = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = p.sum(axis=1)
    d = p[:, 1] - p[:, 0]
    out = np.array([p[np.argmin(s)], p[np.argmin(d)], p[np.argmax(s)], p[np.argmax(d)]])
    if len({tuple(row) for row in out.tolist()}) < 4:
        # Degenerate ordering (e.g. a 45 degree rotation): sort by angle around the centre.
        c = p.mean(axis=0)
        ang = np.arctan2(p[:, 1] - c[1], p[:, 0] - c[0])
        q = p[np.argsort(ang)]  # clockwise in image coordinates, starting near -180 deg
        start = int(np.argmin(q.sum(axis=1)))
        out = np.roll(q, -start, axis=0)
    return out.astype(np.float32)


def quad_area(q: FloatArray) -> float:
    """Signed-agnostic area of a quadrilateral."""
    return float(abs(cv2.contourArea(q.reshape(-1, 1, 2).astype(np.float32))))


def warp(gray: U8Array, corners: FloatArray, side: int) -> U8Array:
    """Perspective-warp the quad *corners* of *gray* to a ``side`` x ``side`` square."""
    dst = np.array([[0, 0], [side - 1, 0], [side - 1, side - 1], [0, side - 1]], np.float32)
    m = cv2.getPerspectiveTransform(corners.astype(np.float32), dst)
    out = cv2.warpPerspective(
        gray, m, (side, side), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    )
    return np.asarray(out, dtype=np.uint8)


def _threshold(gray: U8Array) -> U8Array:
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    block = max(15, (min(gray.shape) // 30) | 1)
    th = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block, 7
    )
    return np.asarray(th, dtype=np.uint8)


def contour_candidates(th: U8Array, max_candidates: int = 6) -> list[FloatArray]:
    """Large convex 4-point contours, largest first."""
    h, w = th.shape
    min_area = MIN_AREA_FRACTION * h * w
    closed = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = [c for c in contours if cv2.contourArea(c) >= min_area * 0.8]
    contours.sort(key=cv2.contourArea, reverse=True)
    out: list[FloatArray] = []
    for c in contours[: max_candidates * 3]:
        hull = cv2.convexHull(c)
        peri = cv2.arcLength(hull, True)
        for eps in (0.02, 0.035, 0.05):
            approx = cv2.approxPolyDP(hull, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                q = order_corners(approx.reshape(4, 2))
                if quad_area(q) >= min_area and not any(_same_quad(q, o) for o in out):
                    out.append(q)
                break
        if len(out) >= max_candidates:
            break
    return out


def _same_quad(a: FloatArray, b: FloatArray) -> bool:
    tol = 0.02 * max(float(np.ptp(a[:, 0])), float(np.ptp(a[:, 1])), 1.0)
    return bool(np.all(np.linalg.norm(a - b, axis=1) < tol))


def hough_candidate(th: U8Array) -> FloatArray | None:
    """Fallback: the outermost long lines of the two dominant directions."""
    h, w = th.shape
    side = min(h, w)
    lines = cv2.HoughLinesP(
        th, 1, np.pi / 360, threshold=80, minLineLength=int(side * 0.25), maxLineGap=side // 40
    )
    if lines is None or len(lines) < 4:
        return None
    seg = lines.reshape(-1, 4).astype(np.float64)
    dx, dy = seg[:, 2] - seg[:, 0], seg[:, 3] - seg[:, 1]
    length = np.hypot(dx, dy)
    ang = np.degrees(np.arctan2(dy, dx)) % 180.0
    # Dominant direction modulo 90 degrees, weighted by length.
    hist, edges = np.histogram(ang % 90.0, bins=90, range=(0, 90), weights=length)
    hist = hist + np.roll(hist, 1) + np.roll(hist, -1)
    base = float(edges[int(np.argmax(hist))] + 0.5)
    fams = []
    for target in (base, base + 90.0):
        diff = np.abs((ang - target + 90.0) % 180.0 - 90.0)
        fams.append(diff < 12.0)
    found: list[tuple[npt.NDArray[np.float64], float]] = []
    for mask in fams:
        if mask.sum() < 2:
            return None
        fam_seg = seg[mask]
        theta = np.radians(np.average(ang[mask], weights=length[mask]))
        normal = np.array([-np.sin(theta), np.cos(theta)])
        mid = (fam_seg[:, :2] + fam_seg[:, 2:]) / 2.0
        off = mid @ normal
        for pick in (np.argmin(off), np.argmax(off)):
            near = np.abs(off - off[pick]) < side * 0.01
            pts = np.concatenate([fam_seg[near, :2], fam_seg[near, 2:]])
            vx, vy, x0, y0 = cv2.fitLine(pts.astype(np.float32), cv2.DIST_L2, 0, 0.01, 0.01)
            n = np.array([-float(vy[0]), float(vx[0])])
            found.append((n, float(n @ np.array([float(x0[0]), float(y0[0])]))))
    pts4 = []
    for i in (0, 1):
        for j in (2, 3):
            a = np.array([found[i][0], found[j][0]])
            b = np.array([found[i][1], found[j][1]])
            if abs(np.linalg.det(a)) < 1e-6:
                return None
            pts4.append(np.linalg.solve(a, b))
    q = order_corners(np.array(pts4))
    if quad_area(q) < MIN_AREA_FRACTION * h * w:
        return None
    return q


def grid_score(gray: U8Array, corners: FloatArray) -> float:
    """0..1: how many of the 20 expected grid lines show up after warping *corners*."""
    s = SCORE_CELL
    side = 9 * s
    sq = warp(gray, corners, side)
    th = _threshold(sq)
    k = int(s * 0.8)
    horiz = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((1, k), np.uint8))
    vert = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((k, 1), np.uint8))
    hp = horiz.mean(axis=1) / 255.0
    vp = vert.mean(axis=0) / 255.0
    r = max(2, int(s * 0.2))
    vals = []
    for prof in (hp, vp):
        for i in range(10):
            c = min(side - 1, i * s)
            vals.append(float(prof[max(0, c - r) : c + r + 1].max()))
    peaks = np.clip(np.array(vals) / 0.45, 0.0, 1.0)
    # Penalise long lines in the middle of cells (e.g. a box of a bigger grid).
    mids = []
    for prof in (hp, vp):
        for i in range(9):
            c = i * s + s // 2
            mids.append(float(prof[c - s // 6 : c + s // 6 + 1].max()))
    penalty = float(np.clip(np.mean(mids) / 0.45, 0.0, 1.0))
    return float(np.clip(peaks.mean() - penalty, 0.0, 1.0))


def _normalised_threshold(gray: U8Array) -> U8Array:
    """Binary ink after dividing out the illumination (robust to hard shadow edges)."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    bg = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, k).astype(np.float32)
    norm = np.clip(gray.astype(np.float32) / np.maximum(bg, 1.0) * 255.0, 0, 255).astype(np.uint8)
    _, th = cv2.threshold(norm, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    return np.asarray(th, dtype=np.uint8)


def _best(
    small: U8Array, th: U8Array, best: tuple[FloatArray, float] | None
) -> tuple[FloatArray, float] | None:
    candidates = contour_candidates(th)
    for i, q in enumerate([*candidates, None]):
        if q is None:
            if best is not None and best[1] >= GOOD_ENOUGH:
                break
            q = hough_candidate(th)
            if q is None:
                break
        score = grid_score(small, q)
        if best is None or score > best[1] + 1e-6:
            best = (q, score)
        if score >= GOOD_ENOUGH and i < len(candidates):
            break
    return best


def detect_grid(gray: U8Array) -> tuple[FloatArray, float] | None:
    """Return the best grid quad (in *gray* pixels) and its score, or ``None``."""
    h, w = gray.shape
    f = min(1.0, DETECT_SIDE / max(h, w))
    small = (
        cv2.resize(gray, (round(w * f), round(h * f)), interpolation=cv2.INTER_AREA)
        if f < 1
        else gray
    )
    small = np.asarray(small, dtype=np.uint8)
    best = _best(small, _threshold(small), None)
    if best is None or best[1] < GOOD_ENOUGH:
        best = _best(small, _normalised_threshold(small), best)
    if best is None:
        return None
    return (best[0] / f).astype(np.float32), best[1]
