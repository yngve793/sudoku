from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from sudoku_api.openapi_export import render_openapi

EXPORT_SCRIPT = "backend/scripts/export_openapi.py"
OPENAPI_FILE = Path(__file__).resolve().parents[1] / "openapi.json"

EXPECTED = {
    ("post", "/api/v1/auth/register"),
    ("post", "/api/v1/auth/verify-email"),
    ("post", "/api/v1/auth/resend-verification"),
    ("post", "/api/v1/auth/forgot-password"),
    ("post", "/api/v1/auth/reset-password"),
    ("post", "/api/v1/auth/login"),
    ("post", "/api/v1/auth/refresh"),
    ("post", "/api/v1/auth/logout"),
    ("get", "/api/v1/me"),
    ("post", "/api/v1/games"),
    ("post", "/api/v1/games/import"),
    ("post", "/api/v1/imports/recognize"),
    ("post", "/api/v1/imports/check"),
    ("get", "/api/v1/games/current"),
    ("get", "/api/v1/games/{game_id}"),
    ("patch", "/api/v1/games/{game_id}"),
    ("post", "/api/v1/games/{game_id}/hint"),
    ("post", "/api/v1/games/{game_id}/search/propagate"),
    ("post", "/api/v1/games/{game_id}/check"),
    ("post", "/api/v1/games/{game_id}/complete"),
    ("get", "/api/v1/scores/me"),
    ("get", "/api/v1/leaderboard"),
    ("get", "/api/v1/leaderboard/me"),
    ("get", "/api/v1/health"),
}


def test_paths_match_plan(app: FastAPI) -> None:
    spec = app.openapi()
    actual = {(m, p) for p, ops in spec["paths"].items() for m in ops}
    assert actual == EXPECTED


def test_every_response_has_a_model(app: FastAPI) -> None:
    spec = app.openapi()
    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            for status, resp in op["responses"].items():
                schema = resp.get("content", {}).get("application/json", {}).get("schema")
                assert schema, (method, path, status)
                assert "$ref" in schema, (method, path, status)
                # /health reports 503 with its own HealthOut body (database down).
                if status.startswith(("4", "5")) and path != "/api/v1/health":
                    assert schema["$ref"].endswith("/ErrorOut"), (method, path, status)
    assert "HTTPValidationError" not in spec["components"]["schemas"]


def test_contract_field_names(app: FastAPI) -> None:
    schemas = app.openapi()["components"]["schemas"]
    assert set(schemas["HintOut"]["properties"]) == {
        "kind", "stage", "technique", "cells", "value", "explanation", "penalty",
    }  # fmt: skip
    assert set(schemas["TokenOut"]["properties"]) == {
        "access_token",
        "token_type",
        "expires_in",
        "user",
    }
    assert set(schemas["ErrorOut"]["properties"]) == {"detail", "code"}
    assert {
        "givens", "current", "notes", "difficulty", "elapsed_seconds", "hints_used",
        "mistakes", "status", "version", "score",
        "hint_costs",
    } <= set(schemas["GameOut"]["properties"])  # fmt: skip
    assert set(schemas["HintCosts"]["properties"]) == {"1", "2", "3"}
    assert schemas["GameSource"]["enum"] == ["generated", "imported"]
    assert "source" in schemas["GameOut"]["required"]
    assert "source" in schemas["ScoreHistoryItem"]["required"]
    assert schemas["Difficulty"]["enum"] == [
        "beginner", "easy", "medium", "hard", "expert", "master", "extreme",
    ]  # fmt: skip


def test_public_endpoints_need_no_auth(app: FastAPI) -> None:
    paths = app.openapi()["paths"]
    assert "security" not in paths["/api/v1/leaderboard"]["get"]
    assert "security" in paths["/api/v1/leaderboard/me"]["get"]


def test_exported_openapi_is_up_to_date() -> None:
    assert OPENAPI_FILE.exists(), f"run {EXPORT_SCRIPT}"
    assert json.loads(OPENAPI_FILE.read_text()) == json.loads(render_openapi()), (
        f"backend/openapi.json is stale; run `uv run python {EXPORT_SCRIPT}`"
    )
