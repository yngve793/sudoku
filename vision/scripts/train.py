"""Train the cell classifier (digit 0-9 + kind) and export it to ONNX.

Reproducible from the seeds below::

    uv run --package sudoku-vision --group train python vision/scripts/train.py

Pipeline:

1. Download (or reuse) the pinned fonts and MNIST (``data_sources.py``).
2. Render synthetic phone photos (``synth.py``) with MNIST *train* digits, run
   the package's own decode + cell extraction on them (with the true corners
   plus a little jitter, to mimic detection error), and keep the features of
   every cell the ink test does not discard. Validation photos use MNIST
   *test* digits and a different seed.
3. Train a small CNN on CPU with deterministic algorithms.
4. Fold BatchNorm into the convolutions and write the ONNX graph directly
   with ``onnx.helper`` (no tracing exporter needed), check it against torch
   with onnxruntime, and write ``digits.onnx`` + ``digits.json``.

Class 0 of the digit head means "no digit" (smudge, shadow edge, line remnant).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import data_sources
import numpy as np
import numpy.typing as npt
import onnx
import onnxruntime as ort
import synth
import torch
from onnx import TensorProto, helper, numpy_helper
from sudoku_vision import cells
from sudoku_vision.decode import decode_image
from torch import nn

MODELS = data_sources.VISION_DIR / "src" / "sudoku_vision" / "models"
MODEL_VERSION = "1.0.0"

# --------------------------------------------------------------- data


_ASSETS: dict[str, synth.Assets] = {}


def _init(split: str) -> None:
    _ASSETS[split] = synth.load_assets(split, download=False)


def _photo_samples(args: tuple[str, int, int]) -> tuple[Any, ...]:
    split, seed, k = args
    assets = _ASSETS[split]
    rng = np.random.default_rng([seed, k])
    ph = synth.synth_photo(rng, assets, unique=False)
    dec = decode_image(ph.jpeg)
    side = float(np.linalg.norm(ph.corners[1] - ph.corners[0])) * dec.scale
    jitter = rng.normal(0, 0.006, (4, 2)) * side
    q = (ph.corners * dec.scale + jitter).astype(np.float32)
    feats = cells.extract(dec.gray, q)
    xs, yd, yk = [], [], []
    for i, f in enumerate(feats):
        g, h = ph.givens[i], ph.handwritten[i]
        digit = g or h
        if f.empty and (digit or rng.random() > 0.05):
            continue  # never reaches the model at inference (keep a few empties)
        xs.append(np.round(f.x * 255).astype(np.uint8))
        yd.append(digit)
        yk.append(0 if g else (1 if h else -1))
    x = np.stack(xs) if xs else np.zeros((0, 2, cells.INPUT, cells.INPUT), np.uint8)
    return x, np.array(yd, np.int64), np.array(yk, np.int64)


def build_set(split: str, seed: int, count: int, workers: int) -> tuple[Any, ...]:
    t0 = time.time()
    jobs = [(split, seed, k) for k in range(count)]
    with ProcessPoolExecutor(workers, initializer=_init, initargs=(split,)) as ex:
        parts = list(ex.map(_photo_samples, jobs, chunksize=8))
    x = np.concatenate([p[0] for p in parts])
    yd = np.concatenate([p[1] for p in parts])
    yk = np.concatenate([p[2] for p in parts])
    print(f"{split}: {count} photos -> {len(x)} cells in {time.time() - t0:.0f}s", flush=True)
    return x, yd, yk


# --------------------------------------------------------------- model

CHANNELS = (24, 32, 48, 64, 96)
POOL_AFTER = (1, 3, 4)  # max-pool after these conv indices
HIDDEN = 96


class Net(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        cin = 2
        for i, cout in enumerate(CHANNELS):
            layers += [
                nn.Conv2d(cin, cout, 3, padding=1, bias=False),
                nn.BatchNorm2d(cout),
                nn.ReLU(),
            ]
            if i in POOL_AFTER:
                layers.append(nn.MaxPool2d(2))
            cin = cout
        self.features = nn.Sequential(*layers)
        self.fc = nn.Linear(CHANNELS[-1] * 16, HIDDEN)
        self.drop = nn.Dropout(0.3)
        self.digit = nn.Linear(HIDDEN, 10)
        self.kind = nn.Linear(HIDDEN, 2)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.features(x).flatten(1)
        h = self.drop(torch.relu(self.fc(h)))
        return self.digit(h), self.kind(h)


def train(net: Net, data: tuple[Any, ...], epochs: int, seed: int) -> None:
    x_all = torch.from_numpy(data[0])
    yd = torch.from_numpy(data[1])
    yk = torch.from_numpy(data[2])
    gen = torch.Generator().manual_seed(seed)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    steps = epochs * ((len(x_all) + 255) // 256)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)
    ce = nn.CrossEntropyLoss()
    ce_kind = nn.CrossEntropyLoss(ignore_index=-1)
    for epoch in range(epochs):
        net.train()
        perm = torch.randperm(len(x_all), generator=gen)
        total, t0 = 0.0, time.time()
        for b in range(0, len(perm), 256):
            idx = perm[b : b + 256]
            xb = x_all[idx].float() / 255.0
            # Light augmentation: random contrast on the whole-cell channel.
            xb[:, 1] *= torch.empty(len(idx), 1, 1).uniform_(0.7, 1.15, generator=gen)
            ld, lk = net(xb)
            loss = ce(ld, yd[idx]) + ce_kind(lk, yk[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item() * len(idx)
        print(
            f"epoch {epoch + 1}/{epochs} loss {total / len(perm):.4f} ({time.time() - t0:.0f}s)",
            flush=True,
        )


@torch.no_grad()
def predict(net: Net, x: npt.NDArray[np.uint8]) -> tuple[npt.NDArray[Any], npt.NDArray[Any]]:
    net.eval()
    ds, ks = [], []
    for b in range(0, len(x), 1024):
        d, k = net(torch.from_numpy(x[b : b + 1024]).float() / 255.0)
        ds.append(torch.softmax(d, 1).numpy())
        ks.append(torch.softmax(k, 1).numpy())
    return np.concatenate(ds), np.concatenate(ks)


def accuracy(
    digit_p: npt.NDArray[Any], kind_p: npt.NDArray[Any], yd: npt.NDArray[Any], yk: npt.NDArray[Any]
) -> dict[str, float]:
    pd, pk = digit_p.argmax(1), kind_p.argmax(1)
    out = {}
    for name, mask in (
        ("printed_digit", yk == 0),
        ("handwritten_digit", yk == 1),
        ("no_digit", yk == -1),
    ):
        out[name] = round(float((pd[mask] == yd[mask]).mean()), 5) if mask.any() else float("nan")
    m = yk >= 0
    out["kind"] = round(float((pk[m] == yk[m]).mean()), 5)
    return out


# --------------------------------------------------------------- ONNX


def to_onnx(net: Net) -> onnx.ModelProto:
    """Write the network as a plain ONNX graph (BatchNorm folded into Conv)."""
    net.eval()
    nodes, inits = [], []
    cur = "x"
    i = 0
    for m in net.features:
        if isinstance(m, nn.Conv2d):
            conv = m
        elif isinstance(m, nn.BatchNorm2d):
            scale = (m.weight / torch.sqrt(m.running_var + m.eps)).detach()
            w = (conv.weight.detach() * scale[:, None, None, None]).numpy().astype(np.float32)
            b = (m.bias.detach() - m.running_mean * scale).numpy().astype(np.float32)
            inits += [numpy_helper.from_array(w, f"c{i}_w"), numpy_helper.from_array(b, f"c{i}_b")]
            nodes.append(
                helper.make_node(
                    "Conv",
                    [cur, f"c{i}_w", f"c{i}_b"],
                    [f"c{i}"],
                    kernel_shape=[3, 3],
                    pads=[1, 1, 1, 1],
                )
            )
            nodes.append(helper.make_node("Relu", [f"c{i}"], [f"r{i}"]))
            cur = f"r{i}"
            i += 1
        elif isinstance(m, nn.MaxPool2d):
            nodes.append(
                helper.make_node("MaxPool", [cur], [f"p{i}"], kernel_shape=[2, 2], strides=[2, 2])
            )
            cur = f"p{i}"
    nodes.append(helper.make_node("Flatten", [cur], ["flat"], axis=1))

    def gemm(name: str, lin: nn.Linear, inp: str, out: str) -> None:
        inits.append(
            numpy_helper.from_array(lin.weight.detach().numpy().astype(np.float32), f"{name}_w")
        )
        inits.append(
            numpy_helper.from_array(lin.bias.detach().numpy().astype(np.float32), f"{name}_b")
        )
        nodes.append(helper.make_node("Gemm", [inp, f"{name}_w", f"{name}_b"], [out], transB=1))

    gemm("fc", net.fc, "flat", "fc")
    nodes.append(helper.make_node("Relu", ["fc"], ["hid"]))
    gemm("digit", net.digit, "hid", "digit_logits")
    gemm("kind", net.kind, "hid", "kind_logits")
    nodes.append(helper.make_node("Softmax", ["digit_logits"], ["digit"], axis=1))
    nodes.append(helper.make_node("Softmax", ["kind_logits"], ["kind"], axis=1))
    graph = helper.make_graph(
        nodes,
        "sudoku_cells",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, ["n", 2, cells.INPUT, cells.INPUT])],
        [
            helper.make_tensor_value_info("digit", TensorProto.FLOAT, ["n", 10]),
            helper.make_tensor_value_info("kind", TensorProto.FLOAT, ["n", 2]),
        ],
        initializer=inits,
    )
    model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", 17)], producer_name="sudoku-vision-train"
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


# --------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser(description="Train the sudoku_vision cell classifier.")
    ap.add_argument("--photos", type=int, default=3000, help="training photos")
    ap.add_argument("--val-photos", type=int, default=300)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--seed", type=int, default=20261120)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument(
        "--threads", type=int, default=8, help="torch CPU threads (fixed for determinism)"
    )
    ap.add_argument("--out", type=Path, default=MODELS)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed % 2**32)
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(args.threads)

    data_sources.ensure_fonts()
    data_sources.load_mnist("train")
    data_sources.load_mnist("test")
    train_set = build_set("train", args.seed, args.photos, args.workers)
    val_set = build_set("test", args.seed + 1, args.val_photos, args.workers)

    net = Net()
    train(net, train_set, args.epochs, args.seed)
    dp, kp = predict(net, val_set[0])
    acc = accuracy(dp, kp, val_set[1], val_set[2])
    print("validation:", acc)

    model = to_onnx(net)
    blob = model.SerializeToString()
    sess = ort.InferenceSession(blob, providers=["CPUExecutionProvider"])
    od, ok = sess.run(["digit", "kind"], {"x": val_set[0][:512].astype(np.float32) / 255.0})
    diff = max(float(np.abs(od - dp[:512]).max()), float(np.abs(ok - kp[:512]).max()))
    print(f"onnx vs torch max abs diff: {diff:.2e}")
    if diff > 1e-3:
        sys.exit("ONNX export does not match the torch model")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "digits.onnx").write_bytes(blob)
    n_train = {
        "cells": len(train_set[0]),
        "printed": int((train_set[2] == 0).sum()),
        "handwritten": int((train_set[2] == 1).sum()),
        "no_digit": int((train_set[2] == -1).sum()),
    }
    meta = {
        "name": "sudoku-vision cell classifier",
        "version": MODEL_VERSION,
        "format": "onnx opset 17",
        "sha256": hashlib.sha256(blob).hexdigest(),
        "size_bytes": len(blob),
        "input": {
            "name": "x",
            "shape": ["n", 2, cells.INPUT, cells.INPUT],
            "dtype": "float32",
            "channels": ["digit crop (contrast-normalised)", "whole cell (ink 0..1)"],
        },
        "outputs": {
            "digit": "softmax over 0..9; 0 = no digit",
            "kind": "softmax over [given, handwritten]",
        },
        "architecture": {
            "conv_channels": list(CHANNELS),
            "pool_after": list(POOL_AFTER),
            "hidden": HIDDEN,
        },
        "training": {
            "command": (
                "uv run --package sudoku-vision --group train python vision/scripts/train.py"
            ),
            "args": {
                k: (str(v) if isinstance(v, Path) else v)
                for k, v in vars(args).items()
                if k != "out"
            },
            "seed": args.seed,
            "photos": args.photos,
            "samples": n_train,
            "data": {
                "printed": (
                    f"synthetic, {len(data_sources.FONTS)} OFL fonts from "
                    f"google/fonts@{data_sources.FONT_COMMIT}"
                ),
                "handwritten": "MNIST train split (60k), torchvision mirror, SHA-256 pinned",
                "photos": (
                    "vision/scripts/synth.py (perspective, rotation, curvature, shadows, "
                    "blur, noise, JPEG)"
                ),
            },
            "torch": torch.__version__,
            "python": platform.python_version(),
        },
        "validation": {
            "photos": args.val_photos,
            "seed": args.seed + 1,
            "data": "MNIST test split digits, same fonts, true corners",
            "accuracy": acc,
            "cells": len(val_set[0]),
        },
        "licenses": data_sources.licenses_block(),
    }
    (args.out / "digits.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {args.out / 'digits.onnx'} ({len(blob) / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
