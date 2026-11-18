from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response, status

from sudoku_api.config import Settings
from sudoku_api.deps import DbDep, EmailSenderDep, RateLimiterDep, SettingsDep
from sudoku_api.errors import ApiError
from sudoku_api.ratelimit import auth_rate_limit, refresh_rate_limit
from sudoku_api.schemas.auth import (
    EmailIn,
    LoginIn,
    RegisterIn,
    ResetPasswordIn,
    TokenOut,
    UserOut,
    VerifyEmailIn,
)
from sudoku_api.schemas.common import MessageOut, error_responses
from sudoku_api.services import auth as auth_service
from sudoku_api.services.auth import SessionTokens
from sudoku_api.services.email import send_safely

REFRESH_COOKIE_PATH = "/api/v1/auth"

router = APIRouter(
    prefix="/auth",
    tags=["auth"],
    responses=error_responses(422, 429),
)

_ACCEPTED = MessageOut(message="If the address can receive email, a message is on its way.")


def _set_refresh_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        key=settings.refresh_cookie_name,
        value=token,
        max_age=settings.refresh_token_ttl_days * 24 * 3600,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
    )


def _clear_refresh_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=settings.refresh_cookie_name,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
    )


def _token_response(response: Response, settings: Settings, tokens: SessionTokens) -> TokenOut:
    _set_refresh_cookie(response, settings, tokens.refresh_token)
    response.headers["Cache-Control"] = "no-store"
    return TokenOut(
        access_token=tokens.access_token,
        expires_in=settings.access_token_ttl_minutes * 60,
        user=UserOut.model_validate(tokens.user),
    )


@router.post(
    "/register",
    dependencies=[Depends(auth_rate_limit)],
    status_code=status.HTTP_202_ACCEPTED,
    response_model=MessageOut,
    responses=error_responses(409),
    summary="Create an account and send a verification email",
    description=(
        "Always 202 for a valid request, even if the email is already registered (the owner "
        "is notified instead). 409 `username_taken` if the public username is in use."
    ),
)
def register(
    body: RegisterIn,
    db: DbDep,
    settings: SettingsDep,
    sender: EmailSenderDep,
    limiter: RateLimiterDep,
    background: BackgroundTasks,
) -> MessageOut:
    message = auth_service.register(db, settings, body.username, str(body.email), body.password)
    # Same response whether or not the email was already registered (no enumeration).
    if limiter.hit(settings.email_rate_limit, "email:register", message.to):
        background.add_task(send_safely, sender, message)
    return MessageOut(message="Check your email to verify your address and finish signing up.")


@router.post(
    "/verify-email",
    dependencies=[Depends(auth_rate_limit)],
    response_model=MessageOut,
    responses=error_responses(400),
    summary="Confirm an email address with the token from the verification email",
)
def verify_email(body: VerifyEmailIn, db: DbDep) -> MessageOut:
    auth_service.verify_email(db, body.token)
    return MessageOut(message="Email verified. You can now log in.")


@router.post(
    "/resend-verification",
    dependencies=[Depends(auth_rate_limit)],
    status_code=status.HTTP_202_ACCEPTED,
    response_model=MessageOut,
    summary="Resend the verification email (same response whether or not the account exists)",
)
def resend_verification(
    body: EmailIn,
    db: DbDep,
    settings: SettingsDep,
    sender: EmailSenderDep,
    limiter: RateLimiterDep,
    background: BackgroundTasks,
) -> MessageOut:
    email = auth_service.normalize_email(str(body.email))
    if limiter.hit(settings.email_rate_limit, "email:verify", email):
        message = auth_service.request_verification(db, settings, email)
        if message is not None:
            background.add_task(send_safely, sender, message)
    return _ACCEPTED


@router.post(
    "/forgot-password",
    dependencies=[Depends(auth_rate_limit)],
    status_code=status.HTTP_202_ACCEPTED,
    response_model=MessageOut,
    summary="Send a password-reset email (same response whether or not the account exists)",
)
def forgot_password(
    body: EmailIn,
    db: DbDep,
    settings: SettingsDep,
    sender: EmailSenderDep,
    limiter: RateLimiterDep,
    background: BackgroundTasks,
) -> MessageOut:
    email = auth_service.normalize_email(str(body.email))
    if limiter.hit(settings.email_rate_limit, "email:reset", email):
        message = auth_service.request_password_reset(db, settings, email)
        if message is not None:
            background.add_task(send_safely, sender, message)
    return _ACCEPTED


@router.post(
    "/reset-password",
    dependencies=[Depends(auth_rate_limit)],
    response_model=MessageOut,
    responses=error_responses(400),
    summary="Set a new password with the token from the reset email; ends all sessions",
)
def reset_password(body: ResetPasswordIn, db: DbDep) -> MessageOut:
    auth_service.reset_password(db, body.token, body.new_password)
    return MessageOut(message="Password updated. Please log in again.")


@router.post(
    "/login",
    dependencies=[Depends(auth_rate_limit)],
    response_model=TokenOut,
    responses=error_responses(401, 403),
    summary="Log in; returns an access token and sets the refresh-token cookie",
)
def login(body: LoginIn, response: Response, db: DbDep, settings: SettingsDep) -> TokenOut:
    tokens = auth_service.login(db, settings, body.email, body.password)
    return _token_response(response, settings, tokens)


def _refresh_cookie(request: Request, settings: SettingsDep) -> str | None:
    return request.cookies.get(settings.refresh_cookie_name)


RefreshCookieDep = Annotated[str | None, Depends(_refresh_cookie)]


@router.post(
    "/refresh",
    dependencies=[Depends(refresh_rate_limit)],
    response_model=TokenOut,
    responses=error_responses(401),
    summary="Rotate the refresh-token cookie and return a new access token",
)
def refresh(
    response: Response,
    db: DbDep,
    settings: SettingsDep,
    refresh_token: RefreshCookieDep,
) -> TokenOut:
    try:
        tokens = auth_service.refresh(db, settings, refresh_token)
    except ApiError as exc:
        # Error responses are rendered from scratch, so carry the cookie removal in headers.
        cleared = Response()
        _clear_refresh_cookie(cleared, settings)
        exc.headers = {**(exc.headers or {}), "set-cookie": cleared.headers["set-cookie"]}
        raise
    return _token_response(response, settings, tokens)


@router.post(
    "/logout",
    dependencies=[Depends(refresh_rate_limit)],
    response_model=MessageOut,
    summary="Revoke the refresh token and clear its cookie",
)
def logout(
    response: Response,
    db: DbDep,
    settings: SettingsDep,
    refresh_token: RefreshCookieDep,
) -> MessageOut:
    auth_service.logout(db, refresh_token)
    _clear_refresh_cookie(response, settings)
    return MessageOut(message="Logged out.")
