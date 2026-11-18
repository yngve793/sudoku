from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import API


def test_health(client: TestClient) -> None:
    r = client.get(f"{API}/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "database": "ok"}


def test_unknown_route_uses_error_format(client: TestClient) -> None:
    r = client.get(f"{API}/nope")
    assert r.status_code == 404
    assert r.json() == {"detail": "Not Found", "code": "not_found"}


def test_cors_allow_list(client: TestClient) -> None:
    allowed = client.options(
        f"{API}/leaderboard",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert allowed.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert allowed.headers.get("access-control-allow-credentials") == "true"
    denied = client.options(
        f"{API}/leaderboard",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in denied.headers
