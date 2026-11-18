from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sudoku_api.models import EmailToken, RefreshToken, User, utcnow

from tests.conftest import (
    API,
    PASSWORD,
    Account,
    extract_token,
    login,
    make_account,
    make_settings,
    register,
    verify_latest,
)


def _refresh_with(client: TestClient, token: str | None) -> Any:
    """Call /auth/refresh presenting exactly `token` (nothing from the cookie jar)."""
    client.cookies.clear()
    return client.post(f"{API}/auth/refresh", headers={"Cookie": f"refresh_token={token}"})


def _err(r: Any) -> str:
    body = r.json()
    assert set(body) == {"detail", "code"}, body
    code: str = body["code"]
    return code


# --- registration & verification ------------------------------------------------------------


def test_register_sends_verification_email(client: TestClient, outbox: list[Any]) -> None:
    register(client, "alice", "Alice@Example.COM")
    assert len(outbox) == 1
    msg = outbox[0]
    assert msg.to == "alice@example.com"  # stored lower-cased
    assert "http://localhost:5173/verify-email?token=" in msg.text
    assert "verify-email?token=" in msg.html


def test_password_is_hashed_with_argon2id(client: TestClient, app: FastAPI) -> None:
    register(client, "alice")
    with app.state.session_factory() as s:
        user = s.scalar(select(User))
        assert user is not None
        assert user.password_hash.startswith("$argon2id$")
        assert PASSWORD not in user.password_hash


def test_email_tokens_are_stored_hashed(
    client: TestClient, app: FastAPI, outbox: list[Any]
) -> None:
    register(client, "alice")
    raw = extract_token(outbox[0].text)
    with app.state.session_factory() as s:
        hashes = s.scalars(select(EmailToken.token_hash)).all()
    assert raw not in hashes
    assert len(hashes) == 1
    assert len(hashes[0]) == 64


def test_duplicate_username_is_reported(client: TestClient) -> None:
    register(client, "alice")
    r = client.post(
        f"{API}/auth/register",
        json={"username": "ALICE", "email": "x@example.com", "password": PASSWORD},
    )
    assert r.status_code == 409
    assert _err(r) == "username_taken"


def test_duplicate_email_is_indistinguishable(
    client: TestClient, outbox: list[Any], alice: Account, app: FastAPI
) -> None:
    fresh = client.post(
        f"{API}/auth/register",
        json={"username": "newbie", "email": "newbie@example.com", "password": PASSWORD},
    )
    outbox.clear()
    dup = client.post(
        f"{API}/auth/register",
        json={"username": "alice2", "email": alice.email.upper(), "password": "other password"},
    )
    assert dup.status_code == fresh.status_code == 202
    assert dup.json() == fresh.json()
    # No second account; the real owner is told instead, and their password is unchanged.
    with app.state.session_factory() as s:
        assert s.scalar(select(User).where(User.username == "alice2")) is None
    assert [m.to for m in outbox] == [alice.email]
    assert "already have" in outbox[0].text
    assert "token=" not in outbox[0].text
    login(client, alice.email)


def test_duplicate_email_of_unverified_account_resends_verification(
    client: TestClient, outbox: list[Any]
) -> None:
    email = register(client, "alice")
    outbox.clear()
    r = client.post(
        f"{API}/auth/register",
        json={"username": "alice2", "email": email, "password": PASSWORD},
    )
    assert r.status_code == 202
    assert [m.to for m in outbox] == [email]
    verify_latest(client, outbox, email)
    login(client, email)  # still the original account and password


def test_username_rules(client: TestClient) -> None:
    for bad in ["ab", "a" * 21, "has space", "dash-name"]:
        r = client.post(
            f"{API}/auth/register",
            json={"username": bad, "email": "u@example.com", "password": PASSWORD},
        )
        assert r.status_code == 422, bad
        assert _err(r) == "validation_error", bad
    for reserved in ["admin", "Sudoku", "xfuckx"]:
        r = client.post(
            f"{API}/auth/register",
            json={"username": reserved, "email": "u@example.com", "password": PASSWORD},
        )
        assert r.status_code == 422, reserved
        assert _err(r) == "username_not_allowed", reserved


def test_short_password_rejected(client: TestClient) -> None:
    r = client.post(
        f"{API}/auth/register",
        json={"username": "alice", "email": "a@example.com", "password": "short"},
    )
    assert r.status_code == 422
    assert _err(r) == "validation_error"


def test_unverified_user_cannot_log_in(client: TestClient) -> None:
    email = register(client, "alice")
    r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 403
    assert _err(r) == "email_not_verified"


def test_unverified_check_happens_after_password(client: TestClient) -> None:
    email = register(client, "alice")
    r = client.post(f"{API}/auth/login", json={"email": email, "password": "wrong-password"})
    assert r.status_code == 401
    assert _err(r) == "invalid_credentials"


def test_verification_link_works_once(client: TestClient, outbox: list[Any]) -> None:
    email = register(client, "alice")
    token = extract_token(outbox[0].text)
    assert client.post(f"{API}/auth/verify-email", json={"token": token}).status_code == 200
    r = client.post(f"{API}/auth/verify-email", json={"token": token})
    assert r.status_code == 400
    assert _err(r) == "invalid_token"
    login(client, email)


def test_expired_verification_token_fails(
    client: TestClient, outbox: list[Any], app: FastAPI
) -> None:
    register(client, "alice")
    token = extract_token(outbox[0].text)
    with app.state.session_factory() as s:
        s.execute(update(EmailToken).values(expires_at=utcnow() - timedelta(seconds=1)))
        s.commit()
    r = client.post(f"{API}/auth/verify-email", json={"token": token})
    assert r.status_code == 400
    assert _err(r) == "invalid_token"


def test_garbage_token_fails(client: TestClient) -> None:
    r = client.post(f"{API}/auth/verify-email", json={"token": "not-a-real-token-at-all"})
    assert r.status_code == 400
    assert _err(r) == "invalid_token"


def test_resend_does_not_reveal_accounts(client: TestClient, outbox: list[Any]) -> None:
    email = register(client, "alice")
    outbox.clear()
    known = client.post(f"{API}/auth/resend-verification", json={"email": email})
    unknown = client.post(f"{API}/auth/resend-verification", json={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    assert [m.to for m in outbox] == [email]


def test_resend_invalidates_previous_token(client: TestClient, outbox: list[Any]) -> None:
    email = register(client, "alice")
    old = extract_token(outbox[0].text)
    client.post(f"{API}/auth/resend-verification", json={"email": email})
    r = client.post(f"{API}/auth/verify-email", json={"token": old})
    assert r.status_code == 400
    verify_latest(client, outbox, email)


def test_resend_for_verified_account_sends_nothing(
    client: TestClient, outbox: list[Any], alice: Account
) -> None:
    outbox.clear()
    r = client.post(f"{API}/auth/resend-verification", json={"email": alice.email})
    assert r.status_code == 202
    assert outbox == []


# --- login / refresh / logout ---------------------------------------------------------------


def test_login_returns_token_user_and_cookie(client: TestClient, outbox: list[Any]) -> None:
    email = register(client, "alice")
    verify_latest(client, outbox, email)
    r = client.post(f"{API}/auth/login", json={"email": email.upper(), "password": PASSWORD})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"access_token", "token_type", "expires_in", "user"}
    assert body["expires_in"] == 15 * 60
    assert body["token_type"] == "bearer"
    assert body["user"]["username"] == "alice"
    assert body["user"]["email_verified"] is True
    cookie = r.headers["set-cookie"].lower()
    assert "refresh_token=" in cookie
    assert "httponly" in cookie
    assert "secure" in cookie
    assert "samesite=strict" in cookie
    assert "path=/api/v1/auth" in cookie


def test_login_with_username(client: TestClient, alice: Account) -> None:
    r = client.post(f"{API}/auth/login", json={"email": "Alice", "password": PASSWORD})
    assert r.status_code == 200


def test_wrong_password_and_unknown_user_look_identical(client: TestClient, alice: Account) -> None:
    a = client.post(f"{API}/auth/login", json={"email": alice.email, "password": "nope-nope"})
    b = client.post(f"{API}/auth/login", json={"email": "who@example.com", "password": "nope"})
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json()
    assert _err(a) == "invalid_credentials"


def test_refresh_rotates_token(client: TestClient, alice: Account, app: FastAPI) -> None:
    old_cookie = client.cookies.get("refresh_token")
    r = client.post(f"{API}/auth/refresh")
    assert r.status_code == 200, r.text
    new_cookie = client.cookies.get("refresh_token")
    assert _refresh_with(client, new_cookie).status_code == 200  # new one works
    assert new_cookie
    assert new_cookie != old_cookie
    me = client.get(f"{API}/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})
    assert me.status_code == 200
    with app.state.session_factory() as s:
        hashes = s.scalars(select(RefreshToken.token_hash)).all()
    assert old_cookie not in hashes
    assert new_cookie not in hashes


def test_refresh_reuse_revokes_all_sessions(client: TestClient, alice: Account) -> None:
    stolen = client.cookies.get("refresh_token")
    assert client.post(f"{API}/auth/refresh").status_code == 200
    current = client.cookies.get("refresh_token")
    assert current != stolen
    # Attacker replays the rotated token.
    r = _refresh_with(client, stolen)
    assert r.status_code == 401
    assert _err(r) == "invalid_token"
    # The legitimate (newest) token is now revoked too.
    assert _refresh_with(client, current).status_code == 401


def test_failed_refresh_clears_cookie(client: TestClient, alice: Account) -> None:
    r = _refresh_with(client, "bogus-token-value")
    assert r.status_code == 401
    cookie = r.headers["set-cookie"].lower()
    assert "refresh_token=" in cookie
    assert "max-age=0" in cookie
    assert "path=/api/v1/auth" in cookie


def test_refresh_without_cookie(client: TestClient) -> None:
    r = client.post(f"{API}/auth/refresh")
    assert r.status_code == 401
    assert _err(r) == "invalid_token"


def test_expired_refresh_token(client: TestClient, alice: Account, app: FastAPI) -> None:
    with app.state.session_factory() as s:
        s.execute(update(RefreshToken).values(expires_at=utcnow() - timedelta(seconds=1)))
        s.commit()
    assert client.post(f"{API}/auth/refresh").status_code == 401


def test_logout_revokes_refresh_token(client: TestClient, alice: Account) -> None:
    token = client.cookies.get("refresh_token")
    r = client.post(f"{API}/auth/logout")
    assert r.status_code == 200
    assert client.cookies.get("refresh_token") is None
    assert _refresh_with(client, token).status_code == 401


def test_access_token_required_and_validated(client: TestClient) -> None:
    r = client.get(f"{API}/me")
    assert r.status_code == 401
    assert _err(r) == "not_authenticated"
    r = client.get(f"{API}/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401
    assert _err(r) == "invalid_token"


def test_expired_access_token_rejected(client: TestClient, alice: Account) -> None:
    from sudoku_api.security import create_access_token

    old = create_access_token(1, make_settings(), now=utcnow() - timedelta(hours=1))
    r = client.get(f"{API}/me", headers={"Authorization": f"Bearer {old}"})
    assert r.status_code == 401
    assert _err(r) == "invalid_token"


# --- password reset -------------------------------------------------------------------------


def test_forgot_password_does_not_reveal_accounts(
    client: TestClient, outbox: list[Any], alice: Account
) -> None:
    outbox.clear()
    known = client.post(f"{API}/auth/forgot-password", json={"email": alice.email})
    unknown = client.post(f"{API}/auth/forgot-password", json={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    assert [m.to for m in outbox] == [alice.email]
    assert "/reset-password?token=" in outbox[0].text


def test_reset_password_flow_invalidates_sessions(
    client: TestClient, outbox: list[Any], alice: Account
) -> None:
    client.post(f"{API}/auth/forgot-password", json={"email": alice.email})
    token = extract_token(outbox[-1].text)
    r = client.post(
        f"{API}/auth/reset-password", json={"token": token, "new_password": "brand new password"}
    )
    assert r.status_code == 200
    # Existing refresh token was revoked.
    assert client.post(f"{API}/auth/refresh").status_code == 401
    # Old password fails, new one works.
    r = client.post(f"{API}/auth/login", json={"email": alice.email, "password": PASSWORD})
    assert r.status_code == 401
    login(client, alice.email, "brand new password")
    # Single use.
    r = client.post(
        f"{API}/auth/reset-password", json={"token": token, "new_password": "another password"}
    )
    assert r.status_code == 400
    assert _err(r) == "invalid_token"


def test_reset_token_expires(
    client: TestClient, outbox: list[Any], alice: Account, app: FastAPI
) -> None:
    client.post(f"{API}/auth/forgot-password", json={"email": alice.email})
    token = extract_token(outbox[-1].text)
    with app.state.session_factory() as s:
        s.execute(update(EmailToken).values(expires_at=utcnow() - timedelta(seconds=1)))
        s.commit()
    r = client.post(
        f"{API}/auth/reset-password", json={"token": token, "new_password": "brand new password"}
    )
    assert r.status_code == 400


def test_verify_token_cannot_reset_password(client: TestClient, outbox: list[Any]) -> None:
    register(client, "alice")
    token = extract_token(outbox[0].text)
    r = client.post(
        f"{API}/auth/reset-password", json={"token": token, "new_password": "brand new password"}
    )
    assert r.status_code == 400


def test_reset_verifies_unverified_account(client: TestClient, outbox: list[Any]) -> None:
    email = register(client, "alice")
    client.post(f"{API}/auth/forgot-password", json={"email": email})
    token = extract_token(outbox[-1].text)
    client.post(
        f"{API}/auth/reset-password", json={"token": token, "new_password": "new password!"}
    )
    login(client, email, "new password!")


def test_me(client: TestClient, alice: Account) -> None:
    r = client.get(f"{API}/me", headers=alice.headers)
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == "alice"
    assert body["email"] == alice.email
    assert body["stats"] == {
        "games_started": 0,
        "games_completed": 0,
        "total_score": 0,
        "best_scores": {},
    }


def test_two_accounts(client: TestClient, outbox: list[Any]) -> None:
    a = make_account(client, outbox, "alice")
    b = make_account(client, outbox, "bob")
    assert a.token != b.token
