"""Shared test helpers: labelled photos (fixtures and real photos)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

TESTS = Path(__file__).resolve().parent
FIXTURES = TESTS / "fixtures"
PHOTOS = TESTS / "photos"
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")


@dataclass(frozen=True)
class Labelled:
    name: str
    image: bytes
    givens: tuple[int, ...]
    handwritten: tuple[int, ...]
    corners: tuple[tuple[float, float], ...] | None

    def truth(self, i: int) -> tuple[int, str]:
        """(digit, kind) expected in cell *i*."""
        if self.givens[i]:
            return self.givens[i], "given"
        if self.handwritten[i]:
            return self.handwritten[i], "handwritten"
        return 0, "empty"


def parse_grid(s: str) -> tuple[int, ...]:
    s = "".join(s.split())
    if len(s) != 81 or any(ch not in "0123456789." for ch in s):
        raise ValueError("grid strings must have 81 characters from 0-9 and '.'")
    return tuple(0 if ch in "0." else int(ch) for ch in s)


def load_dir(directory: Path) -> list[Labelled]:
    out = []
    for img in sorted(directory.glob("*")):
        if img.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        data = json.loads(img.with_suffix(".json").read_text())
        corners = data.get("corners")
        out.append(
            Labelled(
                name=img.name,
                image=img.read_bytes(),
                givens=parse_grid(data["givens"]),
                handwritten=parse_grid(data.get("handwritten", "." * 81)),
                corners=tuple((float(x), float(y)) for x, y in corners) if corners else None,
            )
        )
    return out
