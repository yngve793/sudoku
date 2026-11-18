"""Render the OpenAPI document deterministically (used by scripts/export_openapi.py)."""

from __future__ import annotations

import json

from sudoku_api.config import Settings
from sudoku_api.main import create_app


def render_openapi() -> str:
    # Placeholder settings: building the schema needs no database or secrets.
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        jwt_secret="openapi-export-placeholder-secret-0000",  # noqa: S106 - placeholder
        database_url="sqlite://",
        pool_worker_enabled=False,
        email_backend="console",
    )
    spec = create_app(settings).openapi()
    return json.dumps(spec, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
