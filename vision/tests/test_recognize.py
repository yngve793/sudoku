"""End-to-end recognition on the committed synthetic fixture photos."""

from __future__ import annotations

import importlib
import io

import numpy as np
import pytest
from PIL import Image
from sudoku_vision import Recognition, RecognitionError, recognize
from sudoku_vision.grid import order_corners

from tests.helpers import Labelled


def _corner_error(rec: Recognition, photo: Labelled) -> float:
    assert photo.corners is not None
    truth = np.array(photo.corners)
    side = float(np.linalg.norm(truth[1] - truth[0]))
    return float(np.linalg.norm(np.array(rec.corners) - truth, axis=1).max()) / side


def _accuracy(rec: Recognition, photo: Labelled) -> float:
    right = sum((c.digit, c.kind) == photo.truth(c.index) for c in rec.cells)
    return right / 81


def _check_shape(rec: Recognition, size: tuple[int, int]) -> None:
    assert rec.image_size == size
    assert len(rec.corners) == 4
    assert all(len(p) == 2 and all(isinstance(v, float) for v in p) for p in rec.corners)
    assert len(rec.cells) == 81
    assert 0.0 <= rec.grid_confidence <= 1.0
    assert all(isinstance(w, str) for w in rec.warnings)
    for i, c in enumerate(rec.cells):
        assert c.index == i
        assert 0 <= c.digit <= 9
        assert c.kind in ("empty", "given", "handwritten")
        assert (c.digit == 0) == (c.kind == "empty")
        assert 0.0 <= c.confidence <= 1.0
        assert len(c.alternatives) <= 3
        probs = [p for _, p in c.alternatives]
        assert probs == sorted(probs, reverse=True)
        assert all(1 <= d <= 9 and 0.0 <= p <= 1.0 for d, p in c.alternatives)
        if c.kind == "empty":
            assert c.alternatives == ()
        else:
            assert 1 <= len(c.alternatives) <= 3
            assert c.alternatives[0][0] == c.digit or c.auto_corrected
        assert not (c.auto_corrected and c.kind != "given")


def test_fixture_photos(fixture_photos: list[Labelled]) -> None:
    accs = []
    for photo in fixture_photos:
        rec = recognize(photo.image)
        with Image.open(io.BytesIO(photo.image)) as img:
            _check_shape(rec, img.size)
        assert _corner_error(rec, photo) < 0.03, photo.name
        assert rec.grid_confidence > 0.7
        accs.append(_accuracy(rec, photo))
    assert min(accs) >= 0.95, accs
    assert np.mean(accs) >= 0.98, accs


def test_corners_override_is_used_and_echoed(fixture_photos: list[Labelled]) -> None:
    photo = fixture_photos[0]
    assert photo.corners is not None
    rec = recognize(photo.image, corners=list(photo.corners))
    assert rec.corners == photo.corners
    assert _accuracy(rec, photo) >= 0.95
    assert not any("corners" in w for w in rec.warnings)


def test_bad_corners_override_reads_something_else(fixture_photos: list[Labelled]) -> None:
    photo = fixture_photos[0]
    assert photo.corners is not None
    truth = np.array(photo.corners)
    centre = truth.mean(axis=0)
    # The middle box of the grid only: a different region, and not a full grid.
    inner = [tuple(map(float, centre + (p - centre) / 3)) for p in truth]
    rec = recognize(photo.image, corners=inner)
    assert rec.corners == tuple(inner)
    assert _accuracy(rec, photo) < 0.9
    assert any("corners" in w for w in rec.warnings)


@pytest.mark.parametrize(
    "corners",
    [
        [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)],
        [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (float("nan"), 10.0)],
        [(5.0, 5.0)] * 4,
        [(0.0, 0.0, 1.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)],
    ],
)
def test_invalid_corners_raise_value_error(
    fixture_photos: list[Labelled], corners: list[tuple[float, ...]]
) -> None:
    with pytest.raises(ValueError, match="corners"):
        recognize(fixture_photos[0].image, corners=corners)  # type: ignore[arg-type]


def _png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    return buf.getvalue()


@pytest.mark.parametrize("kind", ["blank", "noise", "gradient", "text"])
def test_photo_without_grid(kind: str) -> None:
    rng = np.random.default_rng(1)
    h, w = 900, 1200
    if kind == "blank":
        arr = np.full((h, w), 230, np.uint8)
    elif kind == "noise":
        arr = rng.integers(0, 256, (h, w), dtype=np.uint8)
    elif kind == "gradient":
        arr = np.tile(np.linspace(40, 240, w, dtype=np.float32), (h, 1)).astype(np.uint8)
    else:  # a page of "text": short dark strokes and one big rectangle (a photo frame)
        arr = np.full((h, w), 235, np.uint8)
        for _ in range(600):
            y, x = int(rng.integers(50, h - 60)), int(rng.integers(50, w - 80))
            arr[y : y + 12, x : x + int(rng.integers(3, 40))] = 30
        arr[100:105, 100:1100] = 0
        arr[800:805, 100:1100] = 0
        arr[100:805, 100:105] = 0
        arr[100:805, 1095:1100] = 0
    with pytest.raises(RecognitionError) as info:
        recognize(_png(arr))
    assert info.value.code == "no_grid_found"


def test_exif_rotated_photo_is_read_upright(fixture_photos: list[Labelled]) -> None:
    photo = fixture_photos[1]
    with Image.open(io.BytesIO(photo.image)) as img:
        upright = img.convert("RGB")
    # Store the pixels rotated 90 degrees counter-clockwise with orientation 6
    # ("rotate 90 clockwise to display"): viewers show the upright photo.
    stored = upright.transpose(Image.Transpose.ROTATE_90)
    exif = Image.Exif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    stored.save(buf, "JPEG", quality=92, exif=exif.tobytes())
    rec = recognize(buf.getvalue())
    assert rec.image_size == upright.size
    assert _corner_error(rec, photo) < 0.03
    assert _accuracy(rec, photo) >= 0.95


def test_png_and_webp_inputs(fixture_photos: list[Labelled]) -> None:
    photo = fixture_photos[2]
    with Image.open(io.BytesIO(photo.image)) as img:
        rgb = img.convert("RGB")
    for fmt, kw in (("PNG", {}), ("WEBP", {"quality": 90})):
        buf = io.BytesIO()
        rgb.save(buf, fmt, **kw)
        rec = recognize(buf.getvalue())
        assert _accuracy(rec, photo) >= 0.95, fmt


def test_order_corners_handles_rotation() -> None:
    sq = np.array([[0, 0], [100, 0], [100, 100], [0, 100]], np.float32)
    for deg in (-30, -10, 0, 10, 30):
        a = np.radians(deg)
        rot = sq @ np.array([[np.cos(a), np.sin(a)], [-np.sin(a), np.cos(a)]], np.float32)
        shuffled = rot[[2, 0, 3, 1]]
        assert np.allclose(order_corners(shuffled), rot, atol=1e-4)


@pytest.mark.slow
def test_real_photos(real_photos: list[Labelled]) -> None:
    if not real_photos:
        pytest.skip("no labelled real photos in vision/tests/photos/")
    accs = []
    for photo in real_photos:
        rec = recognize(photo.image)
        if photo.corners is not None:
            assert _corner_error(rec, photo) < 0.05, photo.name
        accs.append(_accuracy(rec, photo))
    assert np.mean(accs) >= 0.9, accs


def test_model_empty_and_ink_empty_cells_have_no_alternatives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The package attribute ``recognize`` is the function; fetch the module itself.
    rec_mod = importlib.import_module("sudoku_vision.recognize")
    from sudoku_vision.cells import INPUT, CellFeatures
    from sudoku_vision.classifier import Prediction

    def fake_predict(x: np.ndarray) -> Prediction:
        n = len(x)
        digit = np.zeros((n, 10), np.float32)
        digit[:, 0] = 0.9  # "no digit"
        digit[:, 3] = 0.1
        digit[0] = 0.0
        digit[0, 7] = 1.0  # first non-empty cell: a 7
        return Prediction(digit, np.tile(np.array([[0.9, 0.1]], np.float32), (n, 1)))

    monkeypatch.setattr(rec_mod, "predict", fake_predict)
    blank = np.zeros((2, INPUT, INPUT), np.float32)
    feats = [CellFeatures(empty=i % 2 == 1, ink=0.0 if i % 2 else 0.05, x=blank) for i in range(81)]
    cells = rec_mod._classify(feats)
    assert (cells[0].digit, cells[0].kind) == (7, "given")
    assert cells[0].alternatives[0][0] == 7
    assert cells[1].kind == "empty"  # empty by ink
    assert cells[2].kind == "empty"  # empty by the model
    assert all(c.alternatives == () for c in cells if c.kind == "empty")
