"""Benchmark ``sudoku_vision.recognize`` on synthetic photos (and real ones, if any).

    uv run python vision/scripts/benchmark.py --count 300 --seed 1

Synthetic photos use MNIST *test* digits (the model is trained on MNIST
*train*) and are generated in memory, never written to disk. Labelled real
photos in ``vision/tests/photos/`` (see ``vision/tests/photos/README.md``) are
reported separately when present. Recognition runs sequentially in this
process, so the timings are single-photo latencies.

Metrics (cell metrics are over photos whose grid was found):

* grid found: no error and every corner within 5% of the grid side of the truth;
* printed / handwritten digit accuracy: the digit is right (kind ignored);
* kind accuracy: non-empty truth cells read with the right kind;
* empty accuracy: empty truth cells read as empty;
* exact match: all 81 digits and kinds right, before and after correction.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections.abc import Iterator
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import data_sources
import numpy as np
import synth
from sudoku_vision import CellReading, RecognitionError
from sudoku_vision.recognize import recognize_detailed

PHOTOS_DIR = data_sources.VISION_DIR / "tests" / "photos"
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")

TARGETS = {  # PLAN.md §5.6
    "grid_found": 0.98,
    "printed_digit": 0.995,
    "handwritten_digit": 0.97,
    "kind": 0.98,
}
P95_TARGET_S = 1.5


@dataclass
class Case:
    name: str
    image: bytes
    givens: list[int]
    handwritten: list[int]
    corners: np.ndarray | None


@dataclass
class Tally:
    photos: int = 0
    found: int = 0
    errors: dict[str, int] = field(default_factory=dict)
    counts: dict[str, list[int]] = field(default_factory=dict)  # name -> [right, total]
    exact_before: int = 0
    exact_after: int = 0
    corrected: list[int] = field(default_factory=lambda: [0, 0])  # [right, total]
    times: list[float] = field(default_factory=list)

    def add(self, name: str, ok: bool) -> None:
        c = self.counts.setdefault(name, [0, 0])
        c[0] += int(ok)
        c[1] += 1

    def rate(self, name: str) -> float:
        right, total = self.counts.get(name, [0, 0])
        return right / total if total else float("nan")


def parse_grid(s: str) -> list[int]:
    s = "".join(s.split())
    if len(s) != 81 or any(ch not in "0123456789." for ch in s):
        raise ValueError("grid strings must have 81 characters from 0-9 and '.'")
    return [0 if ch in "0." else int(ch) for ch in s]


def load_labelled(directory: Path) -> Iterator[Case]:
    """Image + same-stem ``.json`` labels; see ``vision/tests/photos/README.md``."""
    if not directory.is_dir():
        return
    for img in sorted(directory.iterdir()):
        if img.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        label = img.with_suffix(".json")
        if not label.exists():
            print(f"skipping {img.name}: no {label.name}", file=sys.stderr)
            continue
        data = json.loads(label.read_text())
        corners = np.array(data["corners"], np.float32) if data.get("corners") else None
        yield Case(
            img.name,
            img.read_bytes(),
            parse_grid(data["givens"]),
            parse_grid(data.get("handwritten", "." * 81)),
            corners,
        )


_ASSETS: list[synth.Assets] = []


def _init() -> None:
    _ASSETS.append(synth.load_assets("test", download=False))


def _make(args: tuple[int, int]) -> Case:
    seed, k = args
    ph = synth.synth_photo(np.random.default_rng([seed, k]), _ASSETS[0])
    return Case(f"synth-{seed}-{k}", ph.jpeg, ph.givens, ph.handwritten, ph.corners)


def score_cells(t: Tally, case: Case, cells: tuple[CellReading, ...], after: bool) -> bool:
    exact = True
    for c in cells:
        g, h = case.givens[c.index], case.handwritten[c.index]
        truth_kind = "given" if g else ("handwritten" if h else "empty")
        truth_digit = g or h
        ok = c.digit == truth_digit and c.kind == truth_kind
        exact &= ok
        if after:
            if c.auto_corrected:
                t.corrected[0] += int(c.digit == g)
                t.corrected[1] += 1
            continue
        if truth_kind == "empty":
            t.add("empty", c.kind == "empty")
        else:
            t.add("printed_digit" if g else "handwritten_digit", c.digit == truth_digit)
            t.add("kind", c.kind == truth_kind)
            t.add("missed_digit", c.kind == "empty")
    return exact


def run(cases: list[Case]) -> Tally:
    t = Tally()
    for case in cases:
        t.photos += 1
        t0 = time.perf_counter()
        try:
            rec, raw = recognize_detailed(case.image)
        except RecognitionError as exc:
            t.times.append(time.perf_counter() - t0)
            t.errors[exc.code] = t.errors.get(exc.code, 0) + 1
            continue
        t.times.append(time.perf_counter() - t0)
        if case.corners is not None:
            side = float(np.linalg.norm(case.corners[1] - case.corners[0]))
            err = float(np.linalg.norm(np.array(rec.corners) - case.corners, axis=1).max())
            if err > 0.05 * side:
                t.errors["wrong_grid"] = t.errors.get("wrong_grid", 0) + 1
                continue
        t.found += 1
        t.exact_before += score_cells(t, case, raw, after=False)
        t.exact_after += score_cells(t, case, rec.cells, after=True)
    return t


def report(title: str, t: Tally) -> dict[str, Any]:
    found = t.found / t.photos if t.photos else float("nan")
    times = np.array(t.times) if t.times else np.zeros(1)
    res: dict[str, Any] = {
        "photos": t.photos,
        "grid_found": found,
        "errors": t.errors,
        **{k: t.rate(k) for k in ("printed_digit", "handwritten_digit", "kind", "empty")},
        "missed_digit_rate": t.rate("missed_digit"),
        "cells": {k: v[1] for k, v in t.counts.items() if k != "missed_digit"},
        "exact_before_correction": t.exact_before / t.found if t.found else float("nan"),
        "exact_after_correction": t.exact_after / t.found if t.found else float("nan"),
        "auto_corrected_cells": {"right": t.corrected[0], "total": t.corrected[1]},
        "time_p50_s": float(np.percentile(times, 50)),
        "time_p95_s": float(np.percentile(times, 95)),
        "time_max_s": float(times.max()),
    }
    print(f"\n== {title}: {t.photos} photos")

    def line(label: str, value: float, target: float | None = None, unit: str = "%") -> None:
        shown = f"{value * 100:6.2f} %" if unit == "%" else f"{value:6.3f} s"
        if target is None:
            print(f"  {label:<34}{shown}")
            return
        ok = value >= target if unit == "%" else value < target
        tgt = f"{target * 100:.1f} %" if unit == "%" else f"{target} s"
        print(
            f"  {label:<34}{shown}   target {'>=' if unit == '%' else '<'} {tgt}  "
            f"{'PASS' if ok else 'MISS'}"
        )

    line("grid found", found, TARGETS["grid_found"])
    line("printed-digit accuracy", res["printed_digit"], TARGETS["printed_digit"])
    line("handwritten-digit accuracy", res["handwritten_digit"], TARGETS["handwritten_digit"])
    line("kind accuracy (given/handwritten)", res["kind"], TARGETS["kind"])
    line("empty-cell accuracy", res["empty"])
    line("digits read as empty", res["missed_digit_rate"])
    line("exact match, before correction", res["exact_before_correction"])
    line("exact match, after correction", res["exact_after_correction"])
    print(f"  {'auto-corrected givens (right/all)':<34}{t.corrected[0]} / {t.corrected[1]}")
    line("time p50", res["time_p50_s"], unit="s")
    line("time p95", res["time_p95_s"], P95_TARGET_S, unit="s")
    if t.errors:
        print(f"  failures: {t.errors}")
    print(f"  cells: {res['cells']}")
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description="Benchmark sudoku_vision.recognize.")
    ap.add_argument(
        "--count", type=int, default=300, help="synthetic photos (0 = real photos only)"
    )
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument(
        "--workers",
        type=int,
        default=max(1, (os.cpu_count() or 2) - 1),
        help="processes for generating photos (recognition is sequential)",
    )
    ap.add_argument("--photos", type=Path, default=PHOTOS_DIR, help="labelled real photos")
    ap.add_argument("--json", type=Path, help="also write the results as JSON here")
    args = ap.parse_args()

    results: dict[str, Any] = {"seed": args.seed}
    if args.count > 0:
        data_sources.ensure_fonts()
        data_sources.load_mnist("test")
        t0 = time.time()
        with ProcessPoolExecutor(args.workers, initializer=_init) as ex:
            cases = list(ex.map(_make, [(args.seed, k) for k in range(args.count)], chunksize=4))
        print(f"generated {len(cases)} synthetic photos in {time.time() - t0:.0f}s")
        results["synthetic"] = report("synthetic", run(cases))
    real = list(load_labelled(args.photos))
    if real:
        results["real"] = report(f"real photos ({args.photos})", run(real))
    else:
        print(f"\n(no labelled real photos in {args.photos})")
    if args.json:
        args.json.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
