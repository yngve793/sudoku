"""FastAPI dependencies. Everything comes from `app.state` so tests can swap it, or use
`app.dependency_overrides`."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from sudoku_api.config import Settings
from sudoku_api.errors import ApiError
from sudoku_api.models import User
from sudoku_api.ratelimit import RateLimiter
from sudoku_api.security import decode_access_token
from sudoku_api.services.email import EmailSender
from sudoku_api.services.generation import PuzzleGenerator
from sudoku_api.services.puzzle_source import PuzzleSource


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session


def get_email_sender(request: Request) -> EmailSender:
    sender: EmailSender = request.app.state.email_sender
    return sender


def get_puzzle_source(request: Request) -> PuzzleSource:
    source: PuzzleSource = request.app.state.puzzle_source
    return source


def get_puzzle_generator(request: Request) -> PuzzleGenerator:
    generator: PuzzleGenerator = request.app.state.puzzle_generator
    return generator


def get_rate_limiter(request: Request) -> RateLimiter:
    limiter: RateLimiter = request.app.state.rate_limiter
    return limiter


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbDep = Annotated[Session, Depends(get_db)]
EmailSenderDep = Annotated[EmailSender, Depends(get_email_sender)]
PuzzleSourceDep = Annotated[PuzzleSource, Depends(get_puzzle_source)]
PuzzleGeneratorDep = Annotated[PuzzleGenerator, Depends(get_puzzle_generator)]
RateLimiterDep = Annotated[RateLimiter, Depends(get_rate_limiter)]

_bearer = HTTPBearer(auto_error=False, description="Access token from /auth/login")


def get_current_user(
    db: DbDep,
    settings: SettingsDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    unauthenticated = {"WWW-Authenticate": "Bearer"}
    if credentials is None:
        raise ApiError(401, "not_authenticated", "Not authenticated", unauthenticated)
    user_id = decode_access_token(credentials.credentials, settings)
    user = db.get(User, user_id) if user_id is not None else None
    if user is None:
        raise ApiError(401, "invalid_token", "Invalid or expired access token", unauthenticated)
    return user


CurrentUserDep = Annotated[User, Depends(get_current_user)]
