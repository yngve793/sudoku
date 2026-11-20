"""ONNX digit + kind classifier (model and metadata under ``models/``)."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from importlib import resources
from typing import Any, Final

import numpy as np
import numpy.typing as npt
import onnxruntime as ort  # type: ignore[import-untyped]

MODEL_NAME: Final = "digits.onnx"
METADATA_NAME: Final = "digits.json"

F32 = npt.NDArray[np.float32]

_lock = threading.Lock()
_session: ort.InferenceSession | None = None


@dataclass(frozen=True)
class Prediction:
    """Model output for a batch.

    Attributes:
        digit: (N, 10) probabilities; class 0 means "no digit" (noise, smudge).
        kind: (N, 2) probabilities of ``given`` and ``handwritten``.
    """

    digit: F32
    kind: F32


def _model_bytes(name: str) -> bytes:
    return (resources.files("sudoku_vision") / "models" / name).read_bytes()


def metadata() -> dict[str, Any]:
    """The model's metadata JSON (training data, seeds, accuracy, version)."""
    data: dict[str, Any] = json.loads(_model_bytes(METADATA_NAME))
    return data


def _get_session() -> ort.InferenceSession:
    global _session
    with _lock:
        if _session is None:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1
            opts.inter_op_num_threads = 1
            opts.log_severity_level = 3
            _session = ort.InferenceSession(
                _model_bytes(MODEL_NAME), sess_options=opts, providers=["CPUExecutionProvider"]
            )
        return _session


def predict(x: F32) -> Prediction:
    """Classify a batch of ``(N, 2, 32, 32)`` cell inputs."""
    if len(x) == 0:
        return Prediction(np.zeros((0, 10), np.float32), np.zeros((0, 2), np.float32))
    sess = _get_session()
    digit, kind = sess.run(["digit", "kind"], {"x": np.ascontiguousarray(x, dtype=np.float32)})
    return Prediction(np.asarray(digit, np.float32), np.asarray(kind, np.float32))
