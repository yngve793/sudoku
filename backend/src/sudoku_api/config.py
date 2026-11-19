"""Application settings, loaded from environment variables (see `.env.example`)."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Database
    database_url: str = "sqlite:///./sudoku.db"

    # Auth
    jwt_secret: str = Field(min_length=32)
    jwt_algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
    access_token_ttl_minutes: int = Field(default=15, ge=1, le=60)
    refresh_token_ttl_days: int = Field(default=30, ge=1, le=90)
    verify_email_ttl_hours: int = Field(default=24, ge=1)
    reset_password_ttl_minutes: int = Field(default=60, ge=5)
    cookie_secure: bool = True
    cookie_samesite: Literal["strict", "lax"] = "strict"
    refresh_cookie_name: str = "refresh_token"

    # HTTP
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    frontend_url: str = "http://localhost:5173"

    # Rate limiting (slowapi / `limits` syntax)
    rate_limit_enabled: bool = True
    rate_limit_storage_uri: str = "memory://"
    auth_rate_limit: str = "20/minute"
    # Own bucket: every page load / new tab refreshes the session (logout shares it).
    refresh_rate_limit: str = "60/minute"
    email_rate_limit: str = "3/hour"  # per e-mail address for resend / forgot-password
    hint_rate_limit: str = "30/minute"
    search_rate_limit: str = "120/minute"  # POST /games/{id}/search/propagate

    # Email
    email_backend: Literal["smtp", "console"] = "console"
    smtp_host: str = "localhost"
    smtp_port: int = 1025
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_starttls: bool = False
    smtp_timeout_seconds: float = 10.0
    email_from: str = "Sudoku <no-reply@sudoku.local>"

    # Puzzle pool
    puzzle_source: Literal["fixture", "generator"] = "generator"
    # Generator worker processes (0 = run generation in a thread; used by tests).
    generator_processes: int = Field(default=2, ge=0, le=16)
    # Synchronous fallback in POST /games when the pool is empty.
    generation_timeout_seconds: float = Field(default=5, gt=0)
    # Per-puzzle budget for the background refill (master/extreme can be slow).
    pool_generation_timeout_seconds: float = Field(default=120, gt=0)
    pool_worker_enabled: bool = True
    pool_target_per_level: int = Field(default=20, ge=0)
    pool_refill_interval_seconds: float = Field(default=30, gt=0)

    # Leaderboard
    leaderboard_cache_seconds: float = Field(default=30, ge=0)

    # Logging
    log_level: str = "INFO"
    log_json: bool = True

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [o.strip() for o in value.split(",") if o.strip()]
        return value

    @field_validator("cors_origins")
    @classmethod
    def _no_wildcard(cls, value: list[str]) -> list[str]:
        if "*" in value:
            raise ValueError("CORS_ORIGINS must be an explicit allow-list, '*' is not allowed")
        return value


class DatabaseSettings(BaseSettings):
    """Just the database URL, for tools that must not require the full app config (CLI)."""

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"), env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str = Settings.model_fields["database_url"].default


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from the environment
