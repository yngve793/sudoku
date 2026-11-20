"""The public API surface agreed in PLAN.md §5.6."""

from __future__ import annotations

import dataclasses
import hashlib
import inspect
import json
import pickle
import subprocess
import sys
from importlib import resources
from pathlib import Path

import pytest
import sudoku_vision
from sudoku_vision import CellReading, Recognition, RecognitionError, recognize


def test_exports() -> None:
    for name in ("recognize", "Recognition", "CellReading", "RecognitionError"):
        assert name in sudoku_vision.__all__


def test_cell_reading_fields() -> None:
    assert [f.name for f in dataclasses.fields(CellReading)] == [
        "index",
        "digit",
        "kind",
        "confidence",
        "alternatives",
        "auto_corrected",
    ]
    cell = CellReading(0, 5, "given", 0.9, ((5, 0.9), (6, 0.05), (3, 0.01)), False)
    with pytest.raises(dataclasses.FrozenInstanceError):
        cell.digit = 3  # type: ignore[misc]


def test_recognition_fields() -> None:
    assert [f.name for f in dataclasses.fields(Recognition)] == [
        "corners",
        "image_size",
        "cells",
        "grid_confidence",
        "warnings",
    ]
    assert dataclasses.is_dataclass(Recognition)
    assert Recognition.__dataclass_params__.frozen  # type: ignore[attr-defined]


def test_licenses_ship_next_to_the_model() -> None:
    shipped = (resources.files("sudoku_vision") / "models" / "LICENSES.md").read_text()
    source = (Path(__file__).resolve().parents[1] / "DATA_LICENSES.md").read_text()
    assert shipped == source, "copy vision/DATA_LICENSES.md to src/sudoku_vision/models/LICENSES.md"
    assert "LeCun" in shipped
    assert "Open Font License" in shipped


def test_recognition_error_code() -> None:
    err = RecognitionError("no_grid_found")
    assert err.code == "no_grid_found"
    assert isinstance(err, Exception)


def test_recognition_error_survives_pickling() -> None:
    err = pickle.loads(pickle.dumps(RecognitionError("image_too_large", "too big")))
    assert isinstance(err, RecognitionError)
    assert err.code == "image_too_large"
    assert str(err) == "too big"


def test_results_survive_pickling() -> None:
    cell = CellReading(3, 0, "empty", 1.0, (), False)
    rec = Recognition(((0.0, 0.0),) * 4, (10, 10), (cell,) * 81, 0.9, ("w",))
    assert pickle.loads(pickle.dumps(rec)) == rec


_LIGHT_IMPORT = """
import pickle, sys
import sudoku_vision.types
from sudoku_vision import CellReading, Recognition, RecognitionError
cell = CellReading(0, 0, "empty", 1.0, (), False)
rec = pickle.loads(pickle.dumps(Recognition(((0.0, 0.0),) * 4, (1, 1), (cell,) * 81, 1.0, ())))
err = pickle.loads(pickle.dumps(RecognitionError("no_grid_found")))
heavy = sorted(m for m in ("cv2", "onnxruntime", "PIL", "numpy") if m in sys.modules)
print(",".join(heavy) or "none")
"""


def test_types_import_without_the_image_stack() -> None:
    # The backend unpickles results in the API process; that must stay light.
    out = subprocess.run(
        [sys.executable, "-c", _LIGHT_IMPORT], capture_output=True, text=True, check=True
    )
    assert out.stdout.strip() == "none"


def test_recognize_is_loaded_lazily() -> None:
    assert sudoku_vision.recognize is recognize
    assert callable(recognize)


def test_recognize_signature() -> None:
    sig = inspect.signature(recognize)
    assert list(sig.parameters) == ["image", "corners"]
    assert sig.parameters["corners"].kind is inspect.Parameter.KEYWORD_ONLY
    assert sig.parameters["corners"].default is None


def test_model_artifact_is_small_onnx_with_metadata() -> None:
    models = resources.files("sudoku_vision") / "models"
    blob = (models / "digits.onnx").read_bytes()
    meta = json.loads((models / "digits.json").read_text())
    assert len(blob) < 2 * 1024 * 1024
    assert meta["sha256"] == hashlib.sha256(blob).hexdigest()
    for key in ("version", "training", "validation", "licenses"):
        assert key in meta
    mnist = meta["licenses"]["mnist"]
    assert mnist["authors"] == ["Yann LeCun", "Corinna Cortes", "Christopher J.C. Burges"]
    assert mnist["source_used"].startswith("https://")
    assert mnist["license"]
    assert meta["licenses"]["fonts"]["license"] == "SIL Open Font License 1.1"
    assert "seed" in meta["training"]
    names = {p.name for p in models.iterdir()}
    assert not any(n.endswith((".pkl", ".pickle", ".pt", ".pth")) for n in names)
