"""Password hashing (Argon2id), JWT access tokens and opaque random tokens."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

import jwt
from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher

from sudoku_api.config import Settings

# Argon2id (pwdlib's Argon2Hasher uses argon2-cffi with type ID).
_password_hash = PasswordHash((Argon2Hasher(),))
# Used to equalise timing when a login names an unknown account.
_DUMMY_HASH = _password_hash.hash("timing-equaliser-not-a-real-password")

ACCESS_TOKEN_TYPE = "access"  # noqa: S105 - JWT "typ" claim, not a secret


def hash_password(password: str) -> str:
    return _password_hash.hash(password)


def verify_password(password: str, password_hash: str | None) -> tuple[bool, str | None]:
    """Return (valid, new_hash_if_rehash_needed). Always does the work of one verify."""
    if password_hash is None:
        _password_hash.verify(password, _DUMMY_HASH)
        return False, None
    try:
        return _password_hash.verify_and_update(password, password_hash)
    except Exception:  # malformed hash in DB
        return False, None


def create_access_token(user_id: int, settings: Settings, now: datetime | None = None) -> str:
    issued = now or datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "type": ACCESS_TOKEN_TYPE,
        "iat": int(issued.timestamp()),
        "exp": int((issued + timedelta(minutes=settings.access_token_ttl_minutes)).timestamp()),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str, settings: Settings) -> int | None:
    """Return the user id, or None if the token is invalid or expired."""
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError:
        return None
    if payload.get("type") != ACCESS_TOKEN_TYPE:
        return None
    try:
        return int(payload["sub"])
    except (TypeError, ValueError):
        return None


def new_opaque_token() -> str:
    """32 random bytes, URL-safe. Only its SHA-256 hash is ever stored."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
