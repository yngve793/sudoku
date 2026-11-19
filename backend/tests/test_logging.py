from __future__ import annotations

import logging

import pytest
from sudoku_api.logging_config import HealthCheckAccessFilter, install_access_log_filter

from tests.conftest import make_settings


def _access_record(path: str) -> logging.LogRecord:
    return logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:5000", "GET", path, "1.1", 200),
        None,
    )


@pytest.mark.parametrize(
    ("path", "kept"),
    [
        ("/api/v1/health", False),
        ("/api/v1/health?probe=1", False),
        ("/api/v1/leaderboard", True),
        ("/api/v1/healthy", True),
    ],
)
def test_filter(path: str, kept: bool) -> None:
    assert HealthCheckAccessFilter().filter(_access_record(path)) is kept


def test_filter_installed_once_by_app_setup() -> None:
    from sudoku_api.main import create_app

    create_app(make_settings())
    create_app(make_settings())
    install_access_log_filter()
    access = logging.getLogger("uvicorn.access")
    assert sum(isinstance(f, HealthCheckAccessFilter) for f in access.filters) == 1


def test_access_logger_drops_health_lines(caplog: pytest.LogCaptureFixture) -> None:
    install_access_log_filter()
    logger = logging.getLogger("uvicorn.access")
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        for path in ("/api/v1/health", "/api/v1/me"):
            logger.handle(_access_record(path))
    messages = [r.getMessage() for r in caplog.records]
    assert len(messages) == 1
    assert "/api/v1/me" in messages[0]
