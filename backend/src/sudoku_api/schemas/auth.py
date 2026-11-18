from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, EmailStr, Field, StringConstraints

from sudoku_api.domain import Difficulty
from sudoku_api.schemas.common import ApiModel

Username = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_]{3,20}$")]
Password = Annotated[str, Field(min_length=8, max_length=128)]
OpaqueToken = Annotated[str, Field(min_length=10, max_length=200)]


class RegisterIn(BaseModel):
    username: Username
    email: EmailStr
    password: Password


class EmailIn(BaseModel):
    email: EmailStr


class VerifyEmailIn(BaseModel):
    token: OpaqueToken


class ResetPasswordIn(BaseModel):
    token: OpaqueToken
    new_password: Password


class LoginIn(BaseModel):
    email: Annotated[
        str, Field(min_length=1, max_length=320, description="Email address (or username)")
    ]
    password: Annotated[str, Field(min_length=1, max_length=128)]


class UserOut(ApiModel):
    id: int
    username: str
    email: str
    email_verified: bool
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"  # noqa: S105 - OAuth token type, not a secret
    expires_in: int = Field(description="Access token lifetime in seconds")
    user: UserOut


class UserStatsOut(BaseModel):
    games_started: int
    games_completed: int
    total_score: int
    best_scores: dict[Difficulty, int]


class MeOut(UserOut):
    last_login_at: datetime | None
    stats: UserStatsOut
