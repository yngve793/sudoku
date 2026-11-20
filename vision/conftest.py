"""Skip ``@pytest.mark.slow`` tests unless ``--run-slow`` (or ``-m slow``) is given."""

from __future__ import annotations

import pytest


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--run-slow", action="store_true", help="also run slow tests")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if config.getoption("--run-slow") or "slow" in (config.getoption("-m") or ""):
        return
    skip = pytest.mark.skip(reason="slow test: use --run-slow")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)
