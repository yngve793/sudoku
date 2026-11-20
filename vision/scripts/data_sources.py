"""Pinned, checksum-verified training data: MNIST and a handful of OFL fonts.

Everything is downloaded into ``vision/.cache/<name>/`` (gitignored) from
well-known sources and verified against the SHA-256 values below before use.
Downloaded files are data only: fonts are parsed by FreeType (via Pillow) and
MNIST by numpy; nothing downloaded is ever executed. Licenses: see
``vision/DATA_LICENSES.md``.
"""

from __future__ import annotations

import gzip
import hashlib
import os
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import numpy as np
import numpy.typing as npt

VISION_DIR: Final = Path(__file__).resolve().parents[1]
CACHE: Final = VISION_DIR / ".cache"
MAX_DOWNLOAD: Final = 64 * 1024 * 1024

MNIST_URL: Final = "https://ossci-datasets.s3.amazonaws.com/mnist/"  # the torchvision mirror
# SHA-256 pinned on first download; the MD5s match torchvision's published ones.
MNIST_FILES: Final = {
    "train-images-idx3-ubyte.gz": (
        "440fcabf73cc546fa21475e81ea370265605f56be210a4024d2ca8f203523609"
    ),
    "train-labels-idx1-ubyte.gz": (
        "3552534a0a558bbed6aed32b30c495cca23d567ec52cac8be1a0730e8010255c"
    ),
    "t10k-images-idx3-ubyte.gz": "8d422c7b0a1c1c79245a5bcf07fe86e33eeafee792b84584aec276f5a2dbc4e6",
    "t10k-labels-idx1-ubyte.gz": "f7ae60f92e00ec6debd23a6088c31dbd2371eca3ffa0defaefb259924204aec6",
}

FONT_COMMIT: Final = "cc5661d43cd4f9aad5567033a8e15ca28dc35c86"  # github.com/google/fonts
FONT_URL: Final = f"https://raw.githubusercontent.com/google/fonts/{FONT_COMMIT}/ofl/"


@dataclass(frozen=True)
class FontFile:
    family: str  # directory under ofl/
    name: str  # file name
    sha256: str


FONTS: Final = (
    FontFile(
        "lato",
        "Lato-Regular.ttf",
        "d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251",
    ),
    FontFile(
        "lato", "Lato-Bold.ttf", "8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1"
    ),
    FontFile(
        "firasans",
        "FiraSans-Regular.ttf",
        "c29556a2719bf613ef3d5e070e40d903a8965d9c081beca1375dc1e6e0f93c23",
    ),
    FontFile(
        "firasans",
        "FiraSans-Bold.ttf",
        "a4d8e149ecdd4874a0726eb0af894488b3b31c423d6b0017c8f415ed1b795b45",
    ),
    FontFile(
        "ptserif",
        "PT_Serif-Web-Regular.ttf",
        "a4951fade06ff8f09b7673aa81ffb65a8cd409e24d3289a6dc670bc4dda2557a",
    ),
    FontFile(
        "ptserif",
        "PT_Serif-Web-Bold.ttf",
        "038ba7336bd7ea14f12ad155bed51a4345cac5153275d521dec3ba04021c526e",
    ),
    FontFile(
        "courierprime",
        "CourierPrime-Regular.ttf",
        "72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af",
    ),
    FontFile(
        "courierprime",
        "CourierPrime-Bold.ttf",
        "ff1f38786c849d1c41fa8e447960abdb2bd75fdfb0cfcdeb524fad65a5af3638",
    ),
    FontFile(
        "merriweather",
        "Merriweather[opsz,wdth,wght].ttf",
        "d0ed0e359e396af7ad05e73dffd11a3a4c326ea0d0283c56bd9361cb2cc86a96",
    ),
    FontFile(
        "sourceserif4",
        "SourceSerif4[opsz,wght].ttf",
        "97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b",
    ),
    FontFile(
        "notosans",
        "NotoSans[wdth,wght].ttf",
        "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d",
    ),
    FontFile(
        "opensans",
        "OpenSans[wdth,wght].ttf",
        "36643644f318a812aab2d2ed3bb98f8cf0872527f835fe9398d95fe6b9adb878",
    ),
    FontFile(
        "oswald",
        "Oswald[wght].ttf",
        "5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817",
    ),
    FontFile(
        "librebaskerville",
        "LibreBaskerville[wght].ttf",
        "05a95421961341c5b2556285e8415df9db27dab4f4abe22b446b3c6a8b916c5d",
    ),
    FontFile(
        "robotomono",
        "RobotoMono[wght].ttf",
        "66a80e79d17e4c7cabd162e2916578a4cc08fd19eef6e2a643305eae9c567b2b",
    ),
    FontFile(
        "archivo",
        "Archivo[wdth,wght].ttf",
        "0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053",
    ),
)
FONT_LICENSES: Final = {
    "lato": "74ba064d03f1f1c4a952da936c3eb71866c34404916734de3cae73b34357e59e",
    "firasans": "8f24842e9174beda18a556c2ae7d54f5dc444340c19a3a9ef77e23bca366adbd",
    "ptserif": "ddf311c28ddf5a5ad9747649837346b67bed9d356789c3072bb27dbce49e514d",
    "courierprime": "9a755af092b494944c99f471be6fddd19b006a448fefdc4717e4ee0aa09a97b0",
    "merriweather": "715bd349bfa6116f99e351e1548321dcfa25b91df65502d22ca8d624557697d2",
    "sourceserif4": "5f94c3fd3a23131a417ab5a0c8452de57e70c3cfb9f604d88241f7065ebf9fd9",
    "notosans": "cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a",
    "opensans": "fbbbcfef55318de350562559b671360de6d597112ecc5c73881b05092db89602",
    "oswald": "0fd731a904b729a4e02eaf5e8ebd06783edd9abe400e8882760160230675b652",
    "librebaskerville": "3624eddd4c8f8a908130a417ae7cd089c9da69899c4e0ca1a5217d0a6fae16fd",
    "robotomono": "50ab8dd54680d3473f649c9db86fece88434d097c7834475c1c72d2f8c429215",
    "archivo": "108b4e57c9c796d3d38d0428ca7ee39de47ad93187302718d9b2d8864b9b716b",
}


MNIST_ATTRIBUTION: Final = {
    "dataset": "MNIST database of handwritten digits",
    "authors": ["Yann LeCun", "Corinna Cortes", "Christopher J.C. Burges"],
    "original_page": "http://yann.lecun.com/exdb/mnist/",
    "source_used": MNIST_URL,
    "derived_from": "NIST Special Databases 1 and 3",
    "license": (
        "not stated by the authors' page or by the mirror used (checked 2026-11-20); "
        "the Hugging Face card ylecun/mnist declares MIT; CC BY-SA 3.0 is often cited by "
        "third parties but could not be traced to the authors; attribution is kept"
    ),
}


def licenses_block() -> dict[str, object]:
    """The ``licenses`` entry of ``models/digits.json``."""
    families = sorted({f.family for f in FONTS})
    return {
        "details": "LICENSES.md (next to this file; copy of vision/DATA_LICENSES.md)",
        "mnist": MNIST_ATTRIBUTION,
        "fonts": {
            "license": "SIL Open Font License 1.1",
            "source": f"https://github.com/google/fonts/tree/{FONT_COMMIT}/ofl/",
            "families": families,
            "files": [f.name for f in FONTS],
            "redistributed": False,
        },
    }


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path, sha256: str) -> Path:
    """Download *url* to *dest* unless a verified copy exists; verify SHA-256."""
    if dest.exists() and _sha256(dest) == sha256:
        return dest
    if not url.startswith("https://"):
        raise ValueError(f"refusing non-https download: {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url}")
    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=".part-")
    tmp = Path(tmp_name)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sudoku-vision-train"})  # noqa: S310
        # The scheme is checked above (https only).
        with urllib.request.urlopen(req, timeout=60) as resp, os.fdopen(fd, "wb") as out:  # noqa: S310
            total = 0
            while chunk := resp.read(1 << 20):
                total += len(chunk)
                if total > MAX_DOWNLOAD:
                    raise ValueError(f"download too large: {url}")
                out.write(chunk)
        got = _sha256(tmp)
        if got != sha256:
            raise ValueError(f"checksum mismatch for {url}: expected {sha256}, got {got}")
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return dest


def ensure_fonts() -> list[Path]:
    """Download (if needed) and return the font files, plus their OFL texts."""
    root = CACHE / "fonts"
    for family, sha in FONT_LICENSES.items():
        fetch(f"{FONT_URL}{family}/OFL.txt", root / family / "OFL.txt", sha)
    paths = []
    for font in FONTS:
        quoted = font.name.replace("[", "%5B").replace("]", "%5D")
        paths.append(
            fetch(f"{FONT_URL}{font.family}/{quoted}", root / font.family / font.name, font.sha256)
        )
    return paths


def cached_fonts() -> list[Path] | None:
    """Font paths if all are already cached (no network), else ``None``."""
    paths = [CACHE / "fonts" / f.family / f.name for f in FONTS]
    return paths if all(p.exists() for p in paths) else None


def _read_idx(path: Path, magic: int) -> npt.NDArray[np.uint8]:
    with gzip.open(path, "rb") as f:
        data = f.read(64 * 1024 * 1024)
    head = int.from_bytes(data[:4], "big")
    if head != magic:
        raise ValueError(f"{path.name}: bad idx magic {head:#x}")
    ndim = magic & 0xFF
    dims = [int.from_bytes(data[4 + 4 * i : 8 + 4 * i], "big") for i in range(ndim)]
    body = np.frombuffer(data, dtype=np.uint8, offset=4 + 4 * ndim)
    if body.size != int(np.prod(dims)):
        raise ValueError(f"{path.name}: size mismatch")
    return body.reshape(dims)


def load_mnist(
    split: str, *, download: bool = True
) -> tuple[npt.NDArray[np.uint8], npt.NDArray[np.uint8]]:
    """MNIST ``train`` or ``test`` images (N, 28, 28; white ink on black) and labels."""
    prefix = {"train": "train", "test": "t10k"}[split]
    root = CACHE / "mnist"
    names = (f"{prefix}-images-idx3-ubyte.gz", f"{prefix}-labels-idx1-ubyte.gz")
    for name in names:
        dest = root / name
        if download:
            fetch(MNIST_URL + name, dest, MNIST_FILES[name])
        elif not dest.exists() or _sha256(dest) != MNIST_FILES[name]:
            raise FileNotFoundError(dest)
    images = _read_idx(root / names[0], 0x0803)
    labels = _read_idx(root / names[1], 0x0801)
    return images, labels


def main() -> None:
    fonts = ensure_fonts()
    for split in ("train", "test"):
        images, _ = load_mnist(split)
        print(f"mnist {split}: {len(images)} images")
    print(f"{len(fonts)} fonts in {CACHE / 'fonts'}")


if __name__ == "__main__":
    main()
