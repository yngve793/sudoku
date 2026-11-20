"""Synthetic Sudoku "phone photos" with ground-truth labels.

A photo is rendered in two stages:

1. :func:`render_page`: a printed puzzle page. One font per puzzle (OFL fonts),
   newspaper / puzzle-book styles (line weights, shaded boxes, titles and body
   text, sometimes a neighbouring puzzle), print degradation, and handwritten
   entries from MNIST rendered as pen or pencil ink that may cross grid lines.
2. :func:`photograph`: the page on a textured background with perspective,
   rotation up to +-25 degrees, slight page curvature, a lighting gradient,
   partial shadows, blur, noise and JPEG compression.

Puzzles are real: a seeded backtracking fill, then clues are removed while
``sudoku_validator.count_solutions`` says the solution stays unique.

CLI (writes the committed test fixtures)::

    uv run python vision/scripts/synth.py --count 6 --seed 7 --out vision/tests/fixtures

Labels JSON (shared with real photos under ``vision/tests/photos/``)::

    {"givens": "<81 chars>", "handwritten": "<81 chars>", "corners": [[x, y], x4]}

``givens`` / ``handwritten`` use ``.`` (or ``0``) for "nothing of this kind".
``corners`` (TL, TR, BR, BL in image pixels) is optional.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import data_sources
import numpy as np
import numpy.typing as npt
from PIL import Image, ImageDraw, ImageFont
from sudoku_validator import count_solutions

U8 = npt.NDArray[np.uint8]
F32 = npt.NDArray[np.float32]

WORDS = [
    "sudoku",
    "puzzle",
    "fill",
    "grid",
    "each",
    "row",
    "column",
    "box",
    "contains",
    "digits",
    "once",
    "easy",
    "medium",
    "hard",
    "expert",
    "solution",
    "page",
    "answers",
    "tomorrow",
    "edition",
    "weekend",
    "daily",
    "logic",
    "number",
    "place",
    "the",
    "and",
    "of",
    "to",
    "in",
    "is",
    "that",
    "for",
    "it",
    "with",
    "as",
    "on",
    "by",
]


@dataclass
class Assets:
    """Fonts and handwritten digit images (MNIST, white ink on black)."""

    fonts: list[Path]
    digits: U8
    labels: U8
    by_digit: dict[int, npt.NDArray[np.int64]] = field(init=False)

    def __post_init__(self) -> None:
        self.by_digit = {d: np.flatnonzero(self.labels == d) for d in range(1, 10)}


def load_assets(split: str, *, download: bool = True) -> Assets:
    fonts = data_sources.ensure_fonts() if download else data_sources.cached_fonts()
    if fonts is None:
        raise FileNotFoundError("fonts are not cached; run vision/scripts/data_sources.py")
    images, labels = data_sources.load_mnist(split, download=download)
    return Assets(fonts=fonts, digits=images, labels=labels)


# ----------------------------------------------------------------- puzzles


def full_grid(rng: np.random.Generator) -> list[int]:
    """A random complete Sudoku solution (seeded backtracking)."""
    grid = [0] * 81

    def ok(i: int, d: int) -> bool:
        r, c = divmod(i, 9)
        br, bc = r // 3 * 3, c // 3 * 3
        for k in range(9):
            if grid[r * 9 + k] == d or grid[k * 9 + c] == d:
                return False
            if grid[(br + k // 3) * 9 + bc + k % 3] == d:
                return False
        return True

    def fill(i: int) -> bool:
        if i == 81:
            return True
        for d in rng.permutation(9) + 1:
            if ok(i, int(d)):
                grid[i] = int(d)
                if fill(i + 1):
                    return True
        grid[i] = 0
        return False

    fill(0)
    return grid


def make_puzzle(rng: np.random.Generator, *, unique: bool = True) -> tuple[list[int], list[int]]:
    """``(givens, solution)``. With *unique*, the givens have exactly one solution."""
    solution = full_grid(rng)
    givens = solution.copy()
    target = int(rng.integers(22, 37))
    order = rng.permutation(81)
    if not unique:
        for i in order[: 81 - target]:
            givens[int(i)] = 0
        return givens, solution
    filled = 81
    for i in order:
        if filled <= target:
            break
        keep = givens[int(i)]
        givens[int(i)] = 0
        if count_solutions(tuple(givens), 2) != 1:
            givens[int(i)] = keep
        else:
            filled -= 1
    return givens, solution


def make_entries(rng: np.random.Generator, givens: list[int], solution: list[int]) -> list[int]:
    """Handwritten entries: some empty cells filled, mostly correctly."""
    out = [0] * 81
    frac = float(
        rng.choice([0.0, rng.uniform(0.05, 0.3), rng.uniform(0.3, 0.9)], p=[0.15, 0.4, 0.45])
    )
    for i in range(81):
        if givens[i] == 0 and rng.random() < frac:
            d = solution[i]
            if rng.random() < 0.07:
                d = int(rng.choice([x for x in range(1, 10) if x != d]))
            out[i] = d
    return out


# ----------------------------------------------------------------- page


def _font(path: Path, size: int, rng: np.random.Generator, bold: float) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(path), size)
    try:
        axes = font.get_variation_axes()
    except (OSError, AttributeError):
        return font
    values = []
    for ax in axes:
        name = ax.get("name", b"")
        name = name.decode() if isinstance(name, bytes) else str(name)
        lo, hi, default = ax["minimum"], ax["maximum"], ax["default"]
        if name.lower().startswith("weight"):
            values.append(int(lo + (hi - lo) * bold))
        elif name.lower().startswith("width"):
            values.append(int(np.clip(default * rng.uniform(0.85, 1.05), lo, hi)))
        else:
            values.append(default)
    with contextlib.suppress(OSError):
        font.set_variation_by_axes(values)
    return font


def _hand_glyph(rng: np.random.Generator, assets: Assets, digit: int, height: int) -> F32:
    """A handwritten digit as an alpha mask (0..1) of about *height* pixels."""
    img = assets.digits[int(rng.choice(assets.by_digit[digit]))]
    ys, xs = np.nonzero(img > 30)
    crop = img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1].astype(np.float32) / 255.0
    h = max(6, height)
    w = max(3, round(crop.shape[1] * h / crop.shape[0] * rng.uniform(0.85, 1.2)))
    glyph = cv2.resize(crop, (w, h), interpolation=cv2.INTER_CUBIC)
    pad = h // 3
    glyph = cv2.copyMakeBorder(glyph, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    angle = rng.uniform(-14, 14)
    m = cv2.getRotationMatrix2D((glyph.shape[1] / 2, glyph.shape[0] / 2), angle, 1.0)
    m[0, 1] += rng.uniform(-0.15, 0.15)  # slant
    glyph = cv2.warpAffine(glyph, m, (glyph.shape[1], glyph.shape[0]))
    stroke = rng.random()
    k = max(1, h // 18)
    if stroke < 0.35:
        glyph = cv2.erode(glyph, np.ones((k + 1, k + 1), np.uint8))
    elif stroke > 0.85:
        glyph = cv2.dilate(glyph, np.ones((k, k), np.uint8))
    return np.clip(glyph * 1.4, 0.0, 1.0)


def _paste(layer: F32, glyph: F32, cx: float, cy: float) -> None:
    gh, gw = glyph.shape
    x0, y0 = round(cx - gw / 2), round(cy - gh / 2)
    lx0, ly0 = max(0, x0), max(0, y0)
    lx1, ly1 = min(layer.shape[1], x0 + gw), min(layer.shape[0], y0 + gh)
    if lx1 <= lx0 or ly1 <= ly0:
        return
    sub = glyph[ly0 - y0 : ly1 - y0, lx0 - x0 : lx1 - x0]
    np.maximum(layer[ly0:ly1, lx0:lx1], sub, out=layer[ly0:ly1, lx0:lx1])


def _draw_grid(
    draw: ImageDraw.ImageDraw, x0: int, y0: int, cs: int, thin: int, thick: int, fill: int = 255
) -> None:
    g = cs * 9
    for k in range(10):
        w = thick if k % 3 == 0 else thin
        off = k * cs - w // 2
        draw.rectangle(
            [x0 + off, y0 - thick // 2, x0 + off + w - 1, y0 + g + thick // 2], fill=fill
        )
        draw.rectangle(
            [x0 - thick // 2, y0 + off, x0 + g + thick // 2, y0 + off + w - 1], fill=fill
        )


def _text_line(rng: np.random.Generator, n: int) -> str:
    return " ".join(str(rng.choice(WORDS)) for _ in range(n))


def render_page(
    rng: np.random.Generator, assets: Assets, givens: list[int], hand: list[int]
) -> tuple[U8, F32]:
    """Render the page (RGB) and return it with the grid's outer corners (TL, TR, BR, BL)."""
    cs = int(rng.integers(60, 104))
    g = cs * 9
    ml, mr = (int(g * rng.uniform(0.06, 0.45)) for _ in range(2))
    mt, mb = int(g * rng.uniform(0.15, 0.5)), int(g * rng.uniform(0.08, 0.5))
    neighbour = rng.random() < 0.12
    extra_w = int(g * 1.1) if neighbour else 0
    pw, ph = ml + g + mr + extra_w, mt + g + mb
    x0, y0 = ml, mt

    printed = Image.new("L", (pw, ph), 0)  # printed-ink coverage
    draw = ImageDraw.Draw(printed)
    font_path = assets.fonts[int(rng.integers(len(assets.fonts)))]
    bold = float(rng.uniform(0.2, 0.9))
    thin = max(1, round(cs * rng.uniform(0.012, 0.04)))
    thick = max(thin + 1, round(thin * rng.uniform(1.8, 3.8)))
    line_level = int(rng.uniform(150, 255)) if rng.random() < 0.3 else 255

    if rng.random() < 0.2:  # shaded alternate boxes
        shade = int(rng.uniform(15, 45))
        for b in range(9):
            if b % 2 == 0:
                bx, by = x0 + (b % 3) * 3 * cs, y0 + (b // 3) * 3 * cs
                draw.rectangle([bx, by, bx + 3 * cs, by + 3 * cs], fill=shade)

    # Titles and body text around the grid.
    title_font = _font(
        assets.fonts[int(rng.integers(len(assets.fonts)))], max(12, int(mt * 0.35)), rng, 0.8
    )
    draw.text(
        (x0, int(mt * 0.15)), f"SUDOKU {int(rng.integers(1, 999))}", fill=255, font=title_font
    )
    body_size = max(10, int(cs * rng.uniform(0.18, 0.3)))
    body_font = _font(font_path, body_size, rng, 0.3)
    yy = y0 + g + thick + body_size // 2
    while yy + body_size < ph - 4 and rng.random() < 0.85:
        draw.text((x0, yy), _text_line(rng, int(rng.integers(4, 12))), fill=220, font=body_font)
        yy += int(body_size * 1.5)

    _draw_grid(draw, x0, y0, cs, thin, thick, fill=line_level)
    if neighbour:
        nx = x0 + g + int(g * 0.12)
        _draw_grid(draw, nx, y0, cs, thin, thick, fill=line_level)
        nfont = _font(font_path, int(cs * 0.6), rng, bold)
        for i in rng.choice(81, 28, replace=False):
            r, c = divmod(int(i), 9)
            draw.text(
                (nx + c * cs + cs / 2, y0 + r * cs + cs / 2),
                str(int(rng.integers(1, 10))),
                fill=255,
                font=nfont,
                anchor="mm",
            )

    size = int(cs * rng.uniform(0.5, 0.8))
    dfont = _font(font_path, size, rng, bold)
    for i, d in enumerate(givens):
        if d:
            r, c = divmod(i, 9)
            jx, jy = rng.uniform(-0.03, 0.03, 2) * cs
            draw.text(
                (x0 + c * cs + cs / 2 + jx, y0 + r * cs + cs / 2 + jy),
                str(d),
                fill=255,
                font=dfont,
                anchor="mm",
            )

    p = np.asarray(printed, dtype=np.float32) / 255.0
    if rng.random() < 0.4:  # newsprint: missing-ink speckles and ink spread
        holes = rng.random(p.shape) < rng.uniform(0.005, 0.04)
        p = np.where(holes, p * rng.uniform(0.2, 0.7), p)
    if rng.random() < 0.3:
        p = cv2.dilate(p, np.ones((2, 2), np.uint8))
    p = cv2.GaussianBlur(p, (0, 0), rng.uniform(0.3, 1.0)) * rng.uniform(0.82, 1.0)

    # Handwriting layer, one pen per puzzle.
    hand_layer = np.zeros((ph, pw), np.float32)
    for i, d in enumerate(hand):
        if d:
            r, c = divmod(i, 9)
            glyph = _hand_glyph(rng, assets, d, int(cs * rng.uniform(0.42, 0.78)))
            ox, oy = rng.uniform(-0.14, 0.14, 2) * cs
            _paste(hand_layer, glyph, x0 + c * cs + cs / 2 + ox, y0 + r * cs + cs / 2 + oy)
    pen = rng.choice(["blue", "black", "pencil", "red"], p=[0.4, 0.3, 0.22, 0.08])
    pen_rgb = {
        "blue": (25, 45, 150),
        "black": (25, 25, 35),
        "pencil": (85, 85, 95),
        "red": (170, 30, 35),
    }[str(pen)]
    if pen == "pencil":
        grain = rng.uniform(0.55, 1.0, hand_layer.shape).astype(np.float32)
        hand_layer *= grain * rng.uniform(0.55, 0.9)
    else:
        hand_layer *= rng.uniform(0.8, 1.0)
    hand_layer = cv2.GaussianBlur(hand_layer, (0, 0), 0.6)

    paper = np.array(
        [rng.uniform(225, 255), rng.uniform(222, 252), rng.uniform(205, 245)], np.float32
    )
    page = np.empty((ph, pw, 3), np.float32)
    page[:] = paper
    page += rng.normal(0, rng.uniform(1, 5), (ph, pw, 1)).astype(np.float32)  # paper texture
    print_rgb = np.array(rng.uniform(10, 45, 3), np.float32)
    page = page * (1 - p[..., None]) + print_rgb * p[..., None]
    page = (
        page * (1 - hand_layer[..., None]) + np.array(pen_rgb, np.float32) * hand_layer[..., None]
    )
    corners = np.array([[x0, y0], [x0 + g, y0], [x0 + g, y0 + g], [x0, y0 + g]], np.float32)
    return np.clip(page, 0, 255).astype(np.uint8), corners


# ----------------------------------------------------------------- photo


def _background(rng: np.random.Generator, w: int, h: int) -> F32:
    base = np.array(rng.uniform(30, 200, 3), np.float32)
    small = rng.normal(0, 1, (max(2, h // 64), max(2, w // 64), 3)).astype(np.float32)
    low = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    bg = base + low * rng.uniform(5, 30)
    if rng.random() < 0.4:  # wood-like stripes
        yy = np.arange(h, dtype=np.float32)[:, None, None]
        bg += np.sin(yy / rng.uniform(4, 20) + rng.uniform(0, 6)) * rng.uniform(4, 15)
    bg += rng.normal(0, 4, (h, w, 1)).astype(np.float32)
    return bg


def photograph(rng: np.random.Generator, page: U8, grid: F32, long_side: int) -> tuple[U8, F32]:
    """Photograph *page*; returns the RGB photo and the grid corners in it."""
    portrait = rng.random() < 0.6
    w, h = (int(long_side * 0.75), long_side) if portrait else (long_side, int(long_side * 0.75))
    gs = float(grid[1, 0] - grid[0, 0])
    for _attempt in range(50):
        side = min(w, h) * rng.uniform(0.45, 0.92)
        theta = math.radians(rng.uniform(-25, 25))
        c, s = math.cos(theta), math.sin(theta)
        half = side / 2
        centre = np.array([w / 2, h / 2]) + rng.uniform(-0.12, 0.12, 2) * np.array([w, h])
        unit = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], np.float64) * half
        rot = unit @ np.array([[c, s], [-s, c]])
        dst = rot + centre + rng.uniform(-0.09, 0.09, (4, 2)) * side
        if quad_ok(dst, w, h):
            break
    else:
        dst = unit + np.array([w / 2, h / 2])
    m = cv2.getPerspectiveTransform(grid.astype(np.float32), dst.astype(np.float32))

    # Page curvature: content (x, y) is shown at (x, y + bend(x)).
    ph, pw = page.shape[:2]
    amp = rng.uniform(-0.025, 0.025) * gs
    cx = float(grid[:, 0].mean())

    def bend(x: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
        return amp * ((x - cx) / (gs / 2)) ** 2

    xs, ys = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    inv = np.linalg.inv(m)
    den = inv[2, 0] * xs + inv[2, 1] * ys + inv[2, 2]
    px = (inv[0, 0] * xs + inv[0, 1] * ys + inv[0, 2]) / den
    py = (inv[1, 0] * xs + inv[1, 1] * ys + inv[1, 2]) / den
    py = py - bend(px)
    mapx, mapy = px.astype(np.float32), py.astype(np.float32)
    warped = cv2.remap(page, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    inside = cv2.remap(
        np.ones((ph, pw), np.float32),
        mapx,
        mapy,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0.0,
    )
    photo = warped.astype(np.float32) * inside[..., None] + _background(rng, w, h) * (
        1 - inside[..., None]
    )

    # Lighting gradient, vignette and a partial shadow.
    phi = rng.uniform(0, 2 * math.pi)
    ramp = (np.cos(phi) * xs / w + np.sin(phi) * ys / h).astype(np.float32)
    ramp -= ramp.min()
    light = 1.0 - rng.uniform(0, 0.45) * ramp / max(float(ramp.max()), 1e-6)
    r2 = ((xs / w - 0.5) ** 2 + (ys / h - 0.5) ** 2).astype(np.float32)
    light *= 1.0 - rng.uniform(0, 0.5) * r2
    if rng.random() < 0.55:
        a = rng.uniform(0, 2 * math.pi)
        off = rng.uniform(-0.25, 0.35)
        mask = (np.cos(a) * (xs / w - 0.5) + np.sin(a) * (ys / h - 0.5) > off).astype(np.float32)
        mask = cv2.GaussianBlur(mask, (0, 0), rng.uniform(4, 40))
        light *= 1.0 - rng.uniform(0.2, 0.55) * mask
    photo *= light[..., None]
    photo *= rng.uniform(0.92, 1.08, 3).astype(np.float32)  # white balance

    sigma = rng.uniform(0, 1.4) * long_side / 1500
    if rng.random() < 0.2:
        k = int(rng.integers(3, 8))
        kernel = np.zeros((k, k), np.float32)
        kernel[k // 2, :] = 1.0 / k
        rm = cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), rng.uniform(0, 180), 1.0)
        kernel = cv2.warpAffine(kernel, rm, (k, k))
        photo = cv2.filter2D(photo, -1, kernel / max(float(kernel.sum()), 1e-6))
    elif sigma > 0.3:
        photo = cv2.GaussianBlur(photo, (0, 0), sigma)
    photo += rng.normal(0, rng.uniform(1, 7), photo.shape).astype(np.float32)

    corners = np.array([[x, y + bend(np.array(x))] for x, y in grid], np.float64)
    pts = cv2.perspectiveTransform(corners.reshape(-1, 1, 2), m).reshape(4, 2)
    return np.clip(photo, 0, 255).astype(np.uint8), pts.astype(np.float32)


def quad_ok(q: npt.NDArray[np.float64], w: int, h: int) -> bool:
    m = 0.02 * min(w, h)
    return bool(
        np.all(q[:, 0] > m)
        and np.all(q[:, 0] < w - m)
        and np.all(q[:, 1] > m)
        and np.all(q[:, 1] < h - m)
    )


@dataclass(frozen=True)
class SynthPhoto:
    jpeg: bytes
    givens: list[int]
    handwritten: list[int]
    corners: F32
    size: tuple[int, int]

    def labels(self) -> dict[str, object]:
        return {
            "givens": "".join(str(d) if d else "." for d in self.givens),
            "handwritten": "".join(str(d) if d else "." for d in self.handwritten),
            "corners": [[round(float(x), 2), round(float(y), 2)] for x, y in self.corners],
        }


def synth_photo(
    rng: np.random.Generator,
    assets: Assets,
    *,
    unique: bool = True,
    long_side: tuple[int, int] = (1000, 2000),
    quality: tuple[int, int] = (35, 92),
) -> SynthPhoto:
    """One labelled synthetic photo, JPEG-encoded in memory."""
    givens, solution = make_puzzle(rng, unique=unique)
    hand = make_entries(rng, givens, solution)
    page, grid = render_page(rng, assets, givens, hand)
    photo, corners = photograph(rng, page, grid, int(rng.integers(long_side[0], long_side[1] + 1)))
    buf = io.BytesIO()
    Image.fromarray(photo).save(buf, "JPEG", quality=int(rng.integers(quality[0], quality[1] + 1)))
    return SynthPhoto(buf.getvalue(), givens, hand, corners, (photo.shape[1], photo.shape[0]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--count", type=int, default=6)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--long-side", type=int, nargs=2, default=(900, 1100))
    ap.add_argument("--quality", type=int, nargs=2, default=(60, 80))
    args = ap.parse_args()
    assets = load_assets("test")
    args.out.mkdir(parents=True, exist_ok=True)
    for k in range(args.count):
        rng = np.random.default_rng([args.seed, k])
        ph = synth_photo(rng, assets, long_side=tuple(args.long_side), quality=tuple(args.quality))
        name = f"synth_{args.seed}_{k:02d}"
        (args.out / f"{name}.jpg").write_bytes(ph.jpeg)
        (args.out / f"{name}.json").write_text(json.dumps(ph.labels(), indent=1) + "\n")
        print(f"{name}.jpg {len(ph.jpeg) // 1024} KiB")


if __name__ == "__main__":
    main()
