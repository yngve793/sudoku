"""Accounts, email tokens, login and refresh-token rotation."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from sudoku_api.config import Settings
from sudoku_api.domain import EmailTokenPurpose
from sudoku_api.errors import ApiError
from sudoku_api.models import EmailToken, RefreshToken, User, utcnow
from sudoku_api.security import (
    create_access_token,
    hash_password,
    hash_token,
    new_opaque_token,
    verify_password,
)
from sudoku_api.services.email import OutgoingEmail
from sudoku_api.services.email_templates import (
    account_exists_email,
    reset_password_email,
    verification_email,
)

logger = logging.getLogger(__name__)

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
RESERVED_USERNAMES = frozenset(
    {
        "admin", "administrator", "root", "system", "sysadmin", "moderator", "mod", "staff",
        "support", "help", "official", "sudoku", "api", "me", "null", "undefined", "anonymous",
        "guest", "owner", "security", "webmaster", "postmaster", "noreply", "no_reply",
    }
)  # fmt: skip
BLOCKED_FRAGMENTS = ("fuck", "shit", "cunt", "nigg", "fag", "whore", "rape", "nazi", "hitler")


def normalize_email(email: str) -> str:
    return email.strip().lower()


def check_username(username: str) -> None:
    if not USERNAME_RE.fullmatch(username):
        raise ApiError(
            422, "invalid_username", "Username must be 3-20 characters: letters, digits or _"
        )
    lowered = username.lower()
    if lowered in RESERVED_USERNAMES or any(f in lowered for f in BLOCKED_FRAGMENTS):
        raise ApiError(422, "username_not_allowed", "This username is not allowed")


def _find_user_by_email(session: Session, email: str) -> User | None:
    return session.scalar(select(User).where(User.email == normalize_email(email)))


def _find_user_by_username(session: Session, username: str) -> User | None:
    return session.scalar(select(User).where(func.lower(User.username) == username.lower()))


# --- email tokens ---------------------------------------------------------------------------


def _issue_email_token(
    session: Session, user: User, purpose: EmailTokenPurpose, ttl: timedelta
) -> str:
    now = utcnow()
    # Only the newest token of each purpose stays usable.
    session.execute(
        update(EmailToken)
        .where(
            EmailToken.user_id == user.id,
            EmailToken.purpose == str(purpose),
            EmailToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    raw = new_opaque_token()
    session.add(
        EmailToken(
            user_id=user.id,
            purpose=str(purpose),
            token_hash=hash_token(raw),
            expires_at=now + ttl,
            created_at=now,
        )
    )
    return raw


def _consume_email_token(session: Session, raw: str, purpose: EmailTokenPurpose) -> User:
    now = utcnow()
    token = session.scalar(
        select(EmailToken).where(
            EmailToken.token_hash == hash_token(raw), EmailToken.purpose == str(purpose)
        )
    )
    invalid = ApiError(400, "invalid_token", "This link is invalid or has expired")
    if token is None or token.used_at is not None or token.expires_at <= now:
        raise invalid
    # Conditional update makes the token single-use even under concurrent requests.
    result = session.execute(
        update(EmailToken)
        .where(EmailToken.id == token.id, EmailToken.used_at.is_(None))
        .values(used_at=now)
    )
    if getattr(result, "rowcount", 0) != 1:
        raise invalid
    user = session.get(User, token.user_id)
    if user is None:
        raise invalid
    return user


def _verification_message(session: Session, settings: Settings, user: User) -> OutgoingEmail:
    raw = _issue_email_token(
        session,
        user,
        EmailTokenPurpose.verify_email,
        timedelta(hours=settings.verify_email_ttl_hours),
    )
    return verification_email(
        user.email, user.username, raw, settings.frontend_url, settings.verify_email_ttl_hours
    )


# --- registration & verification ------------------------------------------------------------


def _username_taken() -> ApiError:
    return ApiError(409, "username_taken", "This username is already taken")


def _existing_account_message(session: Session, settings: Settings, user: User) -> OutgoingEmail:
    """What the owner of an already-registered address receives on a repeat registration."""
    if user.email_verified_at is None:
        message = _verification_message(session, settings, user)
        session.commit()
        return message
    return account_exists_email(user.email, user.username, settings.frontend_url)


def register(
    session: Session, settings: Settings, username: str, email: str, password: str
) -> OutgoingEmail:
    """Create an account and return the verification email to send.

    If the email is already registered, nothing is created and the existing owner gets a
    notice (or a fresh verification link if still unverified). The caller responds exactly
    as for a new account, so registration cannot be used to probe for accounts. Usernames
    are public, so a taken username is still reported (409 `username_taken`).
    """
    check_username(username)
    email = normalize_email(email)
    if _find_user_by_username(session, username) is not None:
        raise _username_taken()
    password_hash = hash_password(password)  # always hash: equal timing on both paths
    existing = _find_user_by_email(session, email)
    if existing is not None:
        return _existing_account_message(session, settings, existing)
    user = User(username=username, email=email, password_hash=password_hash)
    session.add(user)
    try:
        session.flush()
    except IntegrityError as exc:  # lost a race on the same username or email
        session.rollback()
        if _find_user_by_username(session, username) is not None:
            raise _username_taken() from exc
        existing = _find_user_by_email(session, email)
        if existing is None:
            raise
        return _existing_account_message(session, settings, existing)
    message = _verification_message(session, settings, user)
    session.commit()
    return message


def verify_email(session: Session, raw_token: str) -> User:
    user = _consume_email_token(session, raw_token, EmailTokenPurpose.verify_email)
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
    session.commit()
    return user


def request_verification(session: Session, settings: Settings, email: str) -> OutgoingEmail | None:
    """Returns a message only for an existing, unverified account. Callers must respond
    identically either way."""
    user = _find_user_by_email(session, email)
    if user is None or user.email_verified_at is not None:
        return None
    message = _verification_message(session, settings, user)
    session.commit()
    return message


# --- password reset -------------------------------------------------------------------------


def request_password_reset(
    session: Session, settings: Settings, email: str
) -> OutgoingEmail | None:
    user = _find_user_by_email(session, email)
    if user is None:
        return None
    raw = _issue_email_token(
        session,
        user,
        EmailTokenPurpose.reset_password,
        timedelta(minutes=settings.reset_password_ttl_minutes),
    )
    session.commit()
    return reset_password_email(
        user.email, user.username, raw, settings.frontend_url, settings.reset_password_ttl_minutes
    )


def reset_password(session: Session, raw_token: str, new_password: str) -> User:
    user = _consume_email_token(session, raw_token, EmailTokenPurpose.reset_password)
    now = utcnow()
    user.password_hash = hash_password(new_password)
    if user.email_verified_at is None:
        user.email_verified_at = now  # the reset link proves control of the mailbox
    _revoke_all_refresh_tokens(session, user.id)
    session.commit()
    return user


# --- sessions -------------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionTokens:
    user: User
    access_token: str
    refresh_token: str


def _revoke_all_refresh_tokens(session: Session, user_id: int) -> None:
    session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )


def _issue_session(session: Session, settings: Settings, user: User) -> SessionTokens:
    now = utcnow()
    raw = new_opaque_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_token(raw),
            expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
            created_at=now,
        )
    )
    return SessionTokens(user, create_access_token(user.id, settings, now), raw)


def login(session: Session, settings: Settings, login_name: str, password: str) -> SessionTokens:
    """`login_name` is an email address or a username."""
    name = login_name.strip()
    user = (
        _find_user_by_email(session, name) if "@" in name else _find_user_by_username(session, name)
    )
    ok, new_hash = verify_password(password, user.password_hash if user else None)
    if user is None or not ok:
        raise ApiError(401, "invalid_credentials", "Incorrect email or password")
    if user.email_verified_at is None:
        raise ApiError(403, "email_not_verified", "Please verify your email address first")
    if new_hash is not None:
        user.password_hash = new_hash
    user.last_login_at = utcnow()
    tokens = _issue_session(session, settings, user)
    session.commit()
    return tokens


def refresh(session: Session, settings: Settings, raw_token: str | None) -> SessionTokens:
    invalid = ApiError(401, "invalid_token", "Session expired, please log in again")
    if not raw_token:
        raise invalid
    now = utcnow()
    token = session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_token))
    )
    if token is None:
        raise invalid
    if token.revoked_at is not None:
        # Reuse of a rotated token: assume theft and end every session of this user.
        logger.warning("refresh token reuse detected for user_id=%s", token.user_id)
        _revoke_all_refresh_tokens(session, token.user_id)
        session.commit()
        raise invalid
    if token.expires_at <= now:
        raise invalid
    result = session.execute(
        update(RefreshToken)
        .where(RefreshToken.id == token.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    if getattr(result, "rowcount", 0) != 1:
        session.rollback()
        raise invalid
    user = session.get(User, token.user_id)
    if user is None or user.email_verified_at is None:
        session.rollback()
        raise invalid
    tokens = _issue_session(session, settings, user)
    session.commit()
    return tokens


def logout(session: Session, raw_token: str | None) -> None:
    if not raw_token:
        return
    session.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == hash_token(raw_token), RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    session.commit()
