from __future__ import annotations

import os
import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from sudoku_api.config import Settings
from sudoku_api.main import create_app
from sudoku_api.models import Base
from sudoku_api.services.email import ConsoleEmailSender
from sudoku_api.services.puzzle_source import FixturePuzzleSource

PASSWORD = "correct horse battery"
API = "/api/v1"


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "jwt_secret": "test-secret-" + "x" * 40,
        # Set TEST_DATABASE_URL (e.g. postgresql+psycopg://...) to run against a real server.
        "database_url": os.environ.get("TEST_DATABASE_URL", "sqlite://"),
        "cookie_secure": True,
        "rate_limit_enabled": False,
        "pool_worker_enabled": False,
        "leaderboard_cache_seconds": 0,
        "email_backend": "console",
        "log_json": False,
        "cors_origins": ["http://localhost:5173"],
        "puzzle_source": "fixture",
        "generator_processes": 0,
        "frontend_url": "http://localhost:5173",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def app(settings: Settings) -> Iterator[FastAPI]:
    application = create_app(
        settings,
        email_sender=ConsoleEmailSender(),
        puzzle_source=FixturePuzzleSource(seed=1),
    )
    Base.metadata.drop_all(application.state.engine)
    Base.metadata.create_all(application.state.engine)
    yield application
    Base.metadata.drop_all(application.state.engine)
    application.state.engine.dispose()


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    # https so the Secure refresh cookie is stored and sent back.
    with TestClient(app, base_url="https://testserver") as c:
        yield c


@pytest.fixture
def outbox(app: FastAPI) -> list[Any]:
    sender: ConsoleEmailSender = app.state.email_sender
    return sender.outbox


@pytest.fixture
def db(app: FastAPI) -> Iterator[Session]:
    with app.state.session_factory() as session:
        yield session


def extract_token(text: str) -> str:
    match = re.search(r"token=([A-Za-z0-9_\-]+)", text)
    assert match, text
    return match.group(1)


@dataclass
class Account:
    username: str
    email: str
    token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


def register(client: TestClient, username: str, email: str | None = None) -> str:
    email = email or f"{username.lower()}@example.com"
    r = client.post(
        f"{API}/auth/register", json={"username": username, "email": email, "password": PASSWORD}
    )
    assert r.status_code == 202, r.text
    return email


def verify_latest(client: TestClient, outbox: list[Any], email: str) -> None:
    msg = next(m for m in reversed(outbox) if m.to == email and "verify" in m.text)
    r = client.post(f"{API}/auth/verify-email", json={"token": extract_token(msg.text)})
    assert r.status_code == 200, r.text


def login(client: TestClient, email: str, password: str = PASSWORD) -> str:
    r = client.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    token: str = r.json()["access_token"]
    return token


def make_account(client: TestClient, outbox: list[Any], username: str = "alice") -> Account:
    email = register(client, username)
    verify_latest(client, outbox, email)
    return Account(username, email, login(client, email))


@pytest.fixture
def alice(client: TestClient, outbox: list[Any]) -> Account:
    return make_account(client, outbox, "alice")


@pytest.fixture
def bob(client: TestClient, outbox: list[Any]) -> Account:
    return make_account(client, outbox, "bob")


def solution_of(app: FastAPI, game_id: int) -> str:
    from sudoku_api.models import Game

    with app.state.session_factory() as s:
        game = s.get(Game, game_id)
        assert game is not None
        solution: str = game.puzzle.solution
        return solution
