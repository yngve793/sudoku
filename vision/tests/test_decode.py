"""Safe decoding: magic bytes, size limits before full decode, EXIF orientation."""

from __future__ import annotations

import io
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from sudoku_vision import RecognitionError, recognize
from sudoku_vision.decode import MAX_BYTES, MAX_PIXELS, MAX_SIDE, decode_image, sniff_format


def _encode(img: Image.Image, fmt: str, **kw: object) -> bytes:
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    return buf.getvalue()


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def _png_claiming(width: int, height: int) -> bytes:
    """A tiny PNG whose header claims width x height pixels (a decompression bomb)."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    idat = zlib.compress(b"\x00" * 1024, 9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", idat)
        + _png_chunk(b"IEND", b"")
    )


def _code(data: bytes) -> str:
    with pytest.raises(RecognitionError) as info:
        recognize(data)
    return info.value.code


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"GIF89a" + b"\x00" * 100,
        b"BM" + b"\x00" * 100,
        b"%PDF-1.7\n",
        b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        b"RIFF\x00\x00\x00\x00WAVE",
    ],
)
def test_wrong_magic_is_unsupported(data: bytes) -> None:
    assert _code(data) == "unsupported_image"


def test_gif_bytes_rejected_even_if_pillow_could_read_them() -> None:
    gif = _encode(Image.new("L", (10, 10), 255), "GIF")
    assert _code(gif) == "unsupported_image"


def test_sniff_formats() -> None:
    img = Image.new("RGB", (8, 8))
    assert sniff_format(_encode(img, "JPEG")) == "JPEG"
    assert sniff_format(_encode(img, "PNG")) == "PNG"
    assert sniff_format(_encode(img, "WEBP")) == "WEBP"


def test_oversized_bytes_rejected_before_decoding() -> None:
    data = b"\xff\xd8\xff" + b"\x00" * MAX_BYTES
    assert _code(data) == "image_too_large"


def test_bomb_header_rejected_without_decoding() -> None:
    bomb = _png_claiming(30_000, 30_000)  # 900 MP from about 100 bytes
    assert len(bomb) < 200
    t0 = time.perf_counter()
    assert _code(bomb) == "image_too_large"
    assert time.perf_counter() - t0 < 0.5


def test_real_compressed_bomb_rejected() -> None:
    # A genuine 42 MP image that compresses to a few KB.
    data = _encode(Image.new("1", (7000, 6000), 1), "PNG", optimize=True)
    assert len(data) < 100_000
    assert _code(data) == "image_too_large"


def test_pixel_limit_applies_to_extreme_aspect_ratios() -> None:
    # Width and height come from the header, so a 1 x 41M canvas is refused unread.
    assert _code(_png_claiming(1, 41_000_000)) == "image_too_large"


@pytest.mark.parametrize(
    "data",
    [
        b"\xff\xd8\xff\xe0" + b"garbage" * 20,
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 50,
        b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 20,
    ],
)
def test_garbage_after_valid_magic_is_unreadable(data: bytes) -> None:
    assert _code(data) == "image_unreadable"


def test_truncated_jpeg_is_unreadable() -> None:
    rng = np.random.default_rng(0)
    img = Image.fromarray(rng.integers(0, 255, (300, 300), dtype=np.uint8))
    data = _encode(img, "JPEG", quality=90)
    assert _code(data[: len(data) // 3]) == "image_unreadable"


def test_downscales_long_side() -> None:
    data = _encode(Image.new("L", (3000, 1500), 200), "PNG")
    dec = decode_image(data)
    assert dec.size == (3000, 1500)
    assert dec.gray.shape == (1000, MAX_SIDE)
    assert dec.scale == pytest.approx(MAX_SIDE / 3000)


def test_jpeg_draft_keeps_long_side_at_limit() -> None:
    data = _encode(Image.new("RGB", (4400, 3300), (200, 200, 200)), "JPEG", quality=50)
    dec = decode_image(data)
    assert dec.size == (4400, 3300)
    assert max(dec.gray.shape) == MAX_SIDE


def test_alpha_is_composited_on_white() -> None:
    img = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    dec = decode_image(_encode(img, "PNG"))
    assert int(dec.gray.min()) == 255


@pytest.mark.parametrize(("orientation", "swapped"), [(1, False), (3, False), (6, True), (8, True)])
def test_exif_orientation_is_applied(orientation: int, swapped: bool) -> None:
    arr = np.full((40, 100), 255, np.uint8)
    arr[:10, :10] = 0  # dark mark in the stored top-left corner
    img = Image.fromarray(arr)
    exif = Image.Exif()
    exif[0x0112] = orientation
    dec = decode_image(_encode(img, "JPEG", quality=95, exif=exif.tobytes()))
    assert dec.size == ((40, 100) if swapped else (100, 40))
    assert dec.gray.shape == ((100, 40) if swapped else (40, 100))
    # Where the stored top-left corner ends up after orientation.
    expected = {1: (0, 0), 3: (-1, -1), 6: (0, -1), 8: (-1, 0)}[orientation]
    y = 4 if expected[0] == 0 else dec.gray.shape[0] - 5
    x = 4 if expected[1] == 0 else dec.gray.shape[1] - 5
    assert dec.gray[y, x] < 100


# ---------------------------------------------------------------- per-format caps and memory


def test_lossless_formats_have_a_lower_pixel_cap() -> None:
    assert MAX_PIXELS["PNG"] < MAX_PIXELS["JPEG"]
    assert MAX_PIXELS["WEBP"] < MAX_PIXELS["JPEG"]
    # 4100 x 4000 = 16.4 MP: too big for PNG (header only), fine as a JPEG.
    assert _code(_png_claiming(4100, 4000)) == "image_too_large"
    jpeg = _encode(Image.new("L", (4100, 4000), 200), "JPEG", quality=50)
    assert decode_image(jpeg).size == (4100, 4000)


def test_sixteen_bit_grayscale_keeps_its_contrast() -> None:
    arr = np.zeros((40, 300), np.uint16)
    arr[:, 100:200] = 30000
    arr[:, 200:] = 65535
    dec = decode_image(_encode(Image.fromarray(arr), "PNG"))
    row = dec.gray[20]
    assert row[50] == 0
    assert 110 <= row[150] <= 120  # 30000 / 65535 * 255 = 116.7
    assert row[250] == 255


def test_twelve_bit_data_in_sixteen_bits_is_stretched() -> None:
    arr = np.zeros((10, 20), np.uint16)
    arr[:, 10:] = 4095
    dec = decode_image(_encode(Image.fromarray(arr), "PNG"))
    assert int(dec.gray[5, 15]) == 255


@pytest.mark.parametrize("fmt", ["PNG", "WEBP"])
def test_semi_transparent_ink_blends_onto_white(fmt: str) -> None:
    img = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    img.paste((0, 0, 0, 128), (0, 0, 10, 20))
    kw = {"lossless": True} if fmt == "WEBP" else {}
    dec = decode_image(_encode(img, fmt, **kw))
    assert int(dec.gray[10, 15]) == 255
    assert 120 <= int(dec.gray[10, 5]) <= 135


def test_la_and_palette_transparency() -> None:
    la = Image.new("LA", (10, 10), (0, 0))
    assert int(decode_image(_encode(la, "PNG")).gray.min()) == 255
    pal = Image.new("P", (10, 10), 0)
    pal.putpalette([0, 0, 0] * 256)
    assert int(decode_image(_encode(pal, "PNG", transparency=0)).gray.min()) == 255


_PEAK_SCRIPT = """
import gc, resource, sys
from pathlib import Path
from sudoku_vision.decode import decode_image
data = Path(sys.argv[1]).read_bytes()
gc.collect()
unit = 1 if sys.platform == "darwin" else 1024
base = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * unit
dec = decode_image(data)
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * unit
print(peak - base, dec.gray.shape[0], dec.gray.shape[1])
"""
PEAK_BUDGET = 300 * 1024 * 1024


def _worst_cases() -> list[tuple[str, Image.Image, str, dict[str, object]]]:
    side = int(MAX_PIXELS["PNG"] ** 0.5)  # 4000 x 4000 = the PNG/WebP cap
    jw = int((MAX_PIXELS["JPEG"] * 4 / 3) ** 0.5)
    jh = MAX_PIXELS["JPEG"] // jw
    return [
        ("png-rgba", Image.new("RGBA", (side, side), (10, 20, 30, 128)), "PNG", {}),
        ("png-16bit", Image.new("I;16", (side, side), 40000), "PNG", {}),
        ("png-rgb", Image.new("RGB", (side, side), (200, 10, 10)), "PNG", {}),
        ("jpeg-rgb", Image.new("RGB", (jw, jh), (200, 200, 200)), "JPEG", {"quality": 50}),
    ]


@pytest.mark.parametrize("case", range(4))
def test_peak_memory_at_the_cap_is_bounded(case: int, tmp_path: Path) -> None:
    name, img, fmt, kw = _worst_cases()[case]
    assert img.size[0] * img.size[1] <= MAX_PIXELS[fmt]
    path = tmp_path / f"{name}.{fmt.lower()}"
    img.save(path, fmt, **kw)
    del img
    assert path.stat().st_size <= MAX_BYTES
    out = subprocess.run(
        [sys.executable, "-c", _PEAK_SCRIPT, str(path)],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    ).stdout.split()
    delta, h, w = (int(v) for v in out)
    assert max(h, w) == MAX_SIDE
    assert delta <= PEAK_BUDGET, f"{name}: decode peaked {delta / 2**20:.0f} MB above baseline"
