"""Slow sweep: fresh synthetic photos (needs the training cache; skipped without it)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from sudoku_vision import RecognitionError
from sudoku_vision.recognize import recognize_detailed

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


@pytest.mark.slow
def test_synthetic_sweep() -> None:
    sys.path.insert(0, str(SCRIPTS))
    try:
        import synth

        try:
            assets = synth.load_assets("test", download=False)
        except FileNotFoundError:
            pytest.skip("fonts/MNIST not cached: run vision/scripts/data_sources.py")
    finally:
        sys.path.remove(str(SCRIPTS))
    found = 0
    right = {"given": [0, 0], "handwritten": [0, 0], "kind": [0, 0]}
    n = 40
    for k in range(n):
        ph = synth.synth_photo(np.random.default_rng([4242, k]), assets)
        try:
            rec, _ = recognize_detailed(ph.jpeg)
        except RecognitionError:
            continue
        found += 1
        for c in rec.cells:
            g, h = ph.givens[c.index], ph.handwritten[c.index]
            if g or h:
                kind = "given" if g else "handwritten"
                right[kind][0] += c.digit == (g or h)
                right[kind][1] += 1
                right["kind"][0] += c.kind == kind
                right["kind"][1] += 1
    assert found >= n - 1
    assert right["given"][0] / right["given"][1] >= 0.99
    assert right["handwritten"][0] / right["handwritten"][1] >= 0.95
    assert right["kind"][0] / right["kind"][1] >= 0.97
