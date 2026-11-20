# vision/: agent notes

**Package:** `sudoku_vision`. It recognises a Sudoku in a photo; the specification is PLAN.md §5.6.
It depends only on `sudoku_validator`'s public API (`find_contradiction`, `count_solutions`, `cell_name`).

## Setup (done by the orchestrator)

- **Runtime dependencies:** numpy, opencv-python-headless, onnxruntime, pillow.
- **`train` group:** torch, onnx. A default `uv sync` doesn't install it; run it with
  `uv run --package sudoku-vision --group train ...`. The Docker image never ships it.
- **Models:** `src/sudoku_vision/models/digits.onnx` + `digits.json`, packaged through `artifacts`.
- **Download cache:** `vision/.cache/` (gitignored): `fonts/<family>/`, `mnist/`.

## Commands

| What | Command |
| --- | --- |
| Verify | `./scripts/verify.sh --only vision` |
| Tests (fast, offline) | `cd vision && uv run pytest` |
| + slow sweeps (need the cache) | `cd vision && uv run pytest --run-slow` |
| Download + verify data | `uv run python vision/scripts/data_sources.py` |
| Train (about 25 min on CPU) | `uv run --package sudoku-vision --group train python vision/scripts/train.py` |
| Benchmark | `uv run python vision/scripts/benchmark.py --count 300 --seed 1` |
| Regenerate fixtures | `uv run python vision/scripts/synth.py --count 6 --seed 7 --out vision/tests/fixtures` |

## Layout

- `decode.py`: magic bytes, then ≤ 10 MB, then a header-only per-format pixel cap, and only then
  the decode. The caps are 40 MP for JPEG and 16 MP for PNG and WebP. JPEG is decoded with
  `draft("L")` at a reduced scale. The image is converted to 8-bit `L` with integer shifts (16/32-bit)
  or an `L` + alpha paste onto white (transparency), never with float. It is downscaled to
  ≤ 2000 px before the EXIF transpose.
  - Measured peaks at the caps: RGBA PNG +167 MB, 16-bit PNG +153 MB, 40 MP JPEG +24 MB.
  - A test enforces ≤ 300 MB (subprocess, `ru_maxrss`). The API container is 1 GB, shared by the
    API and 2 workers.
- `grid.py`: adaptive threshold, then the largest convex 4-point contours, with a Hough fallback.
  Every candidate is scored by `grid_score`: of the 20 expected lines, how many show up after
  warping, minus a penalty for lines in the middle of cells. A score < 0.5 means `no_grid_found`.
  If no candidate scores ≥ 0.9, the search is repeated on an illumination-normalised Otsu
  threshold, which survives hard shadow edges.
- `cells.py`: warp to 432 px and normalise the lighting into "ink". Refine the 10×10 intersections
  locally (this is the de-curving pass), warp each cell to 48 px, drop border-touching blobs,
  then the ink test, then two 32×32 channels: the digit crop and the whole cell.
- `classifier.py`: the ONNX session (1 thread, created lazily). Outputs: `digit` (10 classes,
  class 0 = "no digit") and `kind` (given / handwritten).
- `correct.py`: givens only. It tries the alternatives (p ≥ 0.01) of the lowest-confidence givens:
  singles first, then pairs, within 0.5 s, keeping the most likely fix that is consistent and
  unique. Handwritten cells are only reported in `warnings`.
- `recognize.py`: `recognize()` (public), plus `recognize_detailed()`, which also returns the
  readings before correction (for the benchmark only; not public API).
- `scripts/`:
  - `data_sources.py`: pinned SHA-256 downloads;
  - `synth.py`: pages and photos;
  - `train.py`;
  - `benchmark.py`.
  - The scripts import each other as plain modules, because `scripts/` is on `sys.path` when
    you run them.

## Contract notes (for the backend)

- `RecognitionError` pickles with its `code` (`__reduce__`), so it is safe across the process pool.
- Bad `corners` (not 4 finite pairs, or zero area) raise `ValueError`; map them to 422
  `validation_error`. Corners that don't outline a grid don't raise; they add a warning.
- The returned `corners` echo the caller's override exactly. Detected corners are in the
  oriented-image pixels, rounded to 0.01.
- `alternatives == ()` whenever `kind == "empty"`, whether the ink test or the model decided it.
- `import sudoku_vision` / `sudoku_vision.types` is light: no cv2, onnxruntime, PIL or numpy.
  `recognize` loads lazily (PEP 562), and a subprocess test guards this.

## Pitfalls

- **Training and inference share `cells.extract`.** Any change in `cells.py` or `decode.py`
  changes the classifier's inputs, so retrain and re-run the benchmark.
- **ONNX export:** `torch.onnx.export` needs `onnxscript`, which we don't have. `train.py` writes
  the graph with `onnx.helper` (BatchNorm folded) and checks it against torch (diff < 1e-3).
  If you change the architecture, update `to_onnx`.
- **Determinism:** training runs on CPU with `use_deterministic_algorithms` and a fixed
  `--threads`. Data generation is seeded per photo (`default_rng([seed, k])`), so the worker count
  doesn't change the data.
- **Data split:** MNIST *train* is used for training only. Validation, the benchmark and the
  fixtures use MNIST *test*. The fonts are shared between train and test, so the printed accuracy
  is "seen fonts".
- **Test imports:** the tests import `tests.helpers`. The `sudoku_vision` imports are sorted as
  third-party by ruff (no first-party config); leave them as ruff sorts them.
- **Keep `__init__.py` light.** Never import `recognize`, `decode` or the like eagerly there.
  `sudoku_vision.recognize` (the attribute) is the function and shadows the submodule, so tests
  get the module with `importlib.import_module("sudoku_vision.recognize")`.
- **Licenses:** `src/sudoku_vision/models/LICENSES.md` must be a verbatim copy of
  `DATA_LICENSES.md` (a test checks this). `digits.json["licenses"]` comes from
  `data_sources.licenses_block()`. MNIST's license is unclear (see `DATA_LICENSES.md`).
- Never write images to disk in the package. Only `synth.py --out` (fixtures) writes files.

## Measured (model 1.0.0, 2026-11-20)

| Benchmark run | Grid found | Printed | Handwritten | Kind | Exact (after correction) | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| `--count 300 --seed 1` | 99.67 % | 99.97 % | 97.63 % | 99.62 % | 70.9 % | 0.08 s |
| `--count 500 --seed 2` | 99.40 % | 99.99 % | 97.74 % | 99.70 % | 70.6 % | 0.11 s |

- The exact-match rate is limited by handwritten digits (MNIST is hard), not by the givens.
- Re-run the benchmark after any change to `cells.py`, `decode.py` or the model.

## Real photos

- Put them in `tests/photos/` (format: `tests/photos/README.md`).
- The benchmark reports them separately, and `pytest --run-slow` checks them.
