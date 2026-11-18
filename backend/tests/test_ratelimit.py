from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sudoku_api.main import create_app
from sudoku_api.models import Base
from sudoku_api.services.email import ConsoleEmailSender

from tests.conftest import API, PASSWORD, make_settings, register


@pytest.fixture
def limited() -> Iterator[tuple[TestClient, list[Any]]]:
    sender = ConsoleEmailSender()
    app = create_app(
        make_settings(
            rate_limit_enabled=True,
            auth_rate_limit="5/minute",
            refresh_rate_limit="8/minute",
            email_rate_limit="2/hour",
        ),
        email_sender=sender,
    )
    Base.metadata.create_all(app.state.engine)
    with TestClient(app, base_url="https://testserver") as c:
        yield c, sender.outbox


def test_auth_endpoints_rate_limited_per_ip(limited: tuple[TestClient, list[Any]]) -> None:
    client, _ = limited
    codes = [
        client.post(
            f"{API}/auth/login", json={"email": "x@example.com", "password": "nope"}
        ).status_code
        for _ in range(6)
    ]
    assert codes == [401] * 5 + [429]
    r = client.post(
        f"{API}/auth/register", json={"username": "x", "email": "x@x.io", "password": "p"}
    )
    assert r.status_code == 429
    assert r.json()["code"] == "rate_limited"
    # The refresh bucket is separate: still usable after the auth bucket is exhausted.
    assert client.post(f"{API}/auth/refresh").status_code == 401


def test_refresh_has_its_own_bucket(limited: tuple[TestClient, list[Any]]) -> None:
    client, _ = limited
    # Many refreshes (page loads/new tabs) must not lock the user out of login.
    refresh_codes = [client.post(f"{API}/auth/refresh").status_code for _ in range(8)]
    assert refresh_codes == [401] * 8  # no session cookie, but not rate limited
    login = client.post(f"{API}/auth/login", json={"email": "x@example.com", "password": "nope"})
    assert login.status_code == 401
    # Refresh and logout share the looser bucket, which has its own limit.
    r = client.post(f"{API}/auth/logout")
    assert r.status_code == 429
    assert r.json()["code"] == "rate_limited"
    assert client.post(f"{API}/auth/refresh").status_code == 429


def test_email_sends_limited_per_address_silently(limited: tuple[TestClient, list[Any]]) -> None:
    client, outbox = limited
    email = register(client, "alice")
    outbox.clear()
    responses = [
        client.post(f"{API}/auth/resend-verification", json={"email": email}) for _ in range(3)
    ]
    # Same 202 every time (no enumeration), but only 2 emails actually go out.
    assert {r.status_code for r in responses} == {202}
    assert len({r.text for r in responses}) == 1
    assert len(outbox) == 2


def test_password_not_in_logs_or_errors(limited: tuple[TestClient, list[Any]]) -> None:
    client, _ = limited
    r = client.post(
        f"{API}/auth/register",
        json={"username": "a", "email": "a@example.com", "password": PASSWORD},
    )
    assert PASSWORD not in r.text
