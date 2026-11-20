"""Fixtures for the vision tests."""

from __future__ import annotations

import pytest

from tests.helpers import FIXTURES, PHOTOS, Labelled, load_dir


@pytest.fixture(scope="session")
def fixture_photos() -> list[Labelled]:
    photos = load_dir(FIXTURES)
    assert photos, "committed fixture photos are missing (vision/scripts/synth.py)"
    return photos


@pytest.fixture(scope="session")
def real_photos() -> list[Labelled]:
    return load_dir(PHOTOS)
