"""Structured (JSON-lines) logging."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


HEALTH_PATH = "/api/v1/health"


class HealthCheckAccessFilter(logging.Filter):
    """Drop uvicorn access lines for the health endpoint (container healthchecks).

    uvicorn's access records have args `(client, method, path, http_version, status)`.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            path = str(args[2]).split("?", 1)[0]
            return path != HEALTH_PATH
        return True


def install_access_log_filter() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, HealthCheckAccessFilter) for f in access.filters):
        access.addFilter(HealthCheckAccessFilter())


def configure_logging(level: str, json_logs: bool) -> None:
    install_access_log_filter()
    handler = logging.StreamHandler()
    handler.setFormatter(
        JsonFormatter() if json_logs else logging.Formatter("%(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger("sudoku_api")
    root.handlers = [handler]
    root.setLevel(level.upper())
    root.propagate = False
