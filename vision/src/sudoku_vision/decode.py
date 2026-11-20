"""Safe image decoding: magic bytes, size limits before full decode, EXIF orientation.

Untrusted bytes go through these checks, in order:

1. byte length ``<= MAX_BYTES`` (``image_too_large``);
2. magic bytes are jpeg, png or webp (``unsupported_image``);
3. Pillow reads only the header; the format must match the magic bytes and
   ``width * height`` must be within the per-format cap ``MAX_PIXELS[fmt]``
   (``image_too_large``). Only then is the image decoded, so a small file
   that claims a huge canvas (a decompression bomb) is never expanded;
4. jpeg is decoded with ``draft`` straight to 8-bit grayscale at a reduced DCT
   scale, so even 40 MP stays small. PNG and WebP have no reduced decode,
   so their cap is lower (16 MP): at most 4 bytes per pixel, 64 MB, while loaded;
5. the image is converted to 8-bit ``L`` without float temporaries (integer
   shifts for 16/32-bit, an ``L`` + alpha paste onto white for transparency),
   downscaled so its long side is ``<= MAX_SIDE``, and then EXIF orientation
   is applied.

Peak memory for the worst case at each cap is checked by ``tests/test_decode.py``.
"""

from __future__ import annotations

import io
import warnings
from dataclasses import dataclass
from typing import Final

import numpy as np
import numpy.typing as npt
from PIL import Image

from .types import RecognitionError

MAX_BYTES: Final = 10 * 1024 * 1024
# Per-format pixel caps (checked on the header, before decoding).
MAX_PIXELS: Final = {"JPEG": 40_000_000, "PNG": 16_000_000, "WEBP": 16_000_000}
MAX_SIDE: Final = 2000

_ORIENTATION_TAG: Final = 0x0112
_SWAPS_AXES: Final = frozenset({5, 6, 7, 8})
_T = Image.Transpose
_TRANSPOSE: Final = {
    2: _T.FLIP_LEFT_RIGHT,
    3: _T.ROTATE_180,
    4: _T.FLIP_TOP_BOTTOM,
    5: _T.TRANSPOSE,
    6: _T.ROTATE_270,
    7: _T.TRANSVERSE,
    8: _T.ROTATE_90,
}


@dataclass(frozen=True)
class DecodedImage:
    """A decoded grayscale image.

    Attributes:
        gray: uint8 array (H, W) of the oriented, downscaled image.
        size: ``(width, height)`` of the oriented image *before* downscaling,
            the coordinate system of ``Recognition.corners``.
        scale: ``gray`` pixels per original pixel (``<= 1``).
    """

    gray: npt.NDArray[np.uint8]
    size: tuple[int, int]
    scale: float


def sniff_format(data: bytes) -> str | None:
    """Return ``JPEG``, ``PNG`` or ``WEBP`` from the magic bytes, else ``None``."""
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def decode_image(data: bytes) -> DecodedImage:
    """Decode untrusted *data* into a grayscale image. Raises :class:`RecognitionError`."""
    if len(data) > MAX_BYTES:
        raise RecognitionError("image_too_large", f"image is larger than {MAX_BYTES} bytes")
    fmt = sniff_format(data)
    if fmt is None:
        raise RecognitionError("unsupported_image", "only jpeg, png and webp are supported")
    cap = MAX_PIXELS[fmt]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            img = Image.open(io.BytesIO(data), formats=[fmt])
            width, height = img.size
            if width <= 0 or height <= 0:
                raise RecognitionError("image_unreadable", "image has no pixels")
            if width * height > cap:
                raise RecognitionError(
                    "image_too_large", f"{fmt.lower()} image has more than {cap} pixels"
                )
            orientation = _orientation(img)
            if fmt == "JPEG":
                # Decode to grayscale at a reduced DCT scale (long side stays >= MAX_SIDE).
                factor = min(1.0, MAX_SIDE / max(width, height))
                img.draft("L", (int(width * factor) + 1, int(height * factor) + 1))
            img.load()
            gray_img = _shrink(_to_gray(img))
            del img
            if orientation in _TRANSPOSE:
                gray_img = gray_img.transpose(_TRANSPOSE[orientation])
    except RecognitionError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise RecognitionError("image_too_large", "image is too large to decode") from exc
    except (OSError, ValueError, SyntaxError, EOFError, MemoryError) as exc:
        raise RecognitionError("image_unreadable", "image could not be decoded") from exc

    size = (height, width) if orientation in _SWAPS_AXES else (width, height)
    gray = np.asarray(gray_img, dtype=np.uint8)
    return DecodedImage(gray=gray, size=size, scale=gray.shape[1] / size[0])


def _shrink(img: Image.Image) -> Image.Image:
    """Downscale an ``L`` image so its long side is at most ``MAX_SIDE``."""
    long_side = max(img.size)
    if long_side <= MAX_SIDE:
        return img
    factor = MAX_SIDE / long_side
    target = (max(1, round(img.size[0] * factor)), max(1, round(img.size[1] * factor)))
    return img.resize(target, Image.Resampling.BOX)


def _orientation(img: Image.Image) -> int:
    try:
        value = img.getexif().get(_ORIENTATION_TAG, 1)
    except Exception:  # malformed EXIF must not break decoding
        return 1
    return value if isinstance(value, int) and 1 <= value <= 8 else 1


_ALPHA_MODES: Final = frozenset({"RGBA", "RGBa", "LA", "La", "PA"})
_WIDE_MODES: Final = frozenset({"I;16", "I;16L", "I;16B", "I;16N", "I"})


def _to_gray(img: Image.Image) -> Image.Image:
    """8-bit ``L``; transparent pixels are composited onto white. No float temporaries."""
    mode = img.mode
    if mode == "L":
        return img
    if mode in _ALPHA_MODES or (mode == "P" and "transparency" in img.info):
        lum, alpha = img.convert("LA").split()
        out = Image.new("L", img.size, 255)
        out.paste(lum, mask=alpha)  # 8-bit blend: lum * a + 255 * (1 - a)
        return out
    if mode in _WIDE_MODES:
        arr = np.asarray(img)
        if arr.dtype.kind == "i":
            arr = np.maximum(arr, 0)
        top = int(arr.max()) if arr.size else 0
        shift = max(0, top.bit_length() - 8)  # keep the top 8 significant bits
        return Image.fromarray((arr >> shift).astype(np.uint8))
    return img.convert("L")
