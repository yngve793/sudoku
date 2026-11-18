"""End-to-end with the real `sudoku_generator` (easy/beginner only, fixed seeds: fast).

Harder levels are covered by the generator package's own (slow) test suite.
"""

from __future__ import annotations

from collections.abc import Iterator
from importlib.metadata import version

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sudoku_api.domain import Difficulty
from sudoku_api.main import create_app
from sudoku_api.models import Base, Game
from sudoku_api.services import pool
from sudoku_api.services import puzzle_logic as pl
from sudoku_api.services.email import ConsoleEmailSender
from sudoku_api.services.puzzle_source import GeneratorPuzzleSource

from tests.conftest import API, make_account, make_settings

FAST_LEVELS = [Difficulty.beginner, Difficulty.easy]


@pytest.fixture(params=[0, 1], ids=["thread", "process-pool"])
def real_app(
    request: pytest.FixtureRequest,
) -> Iterator[tuple[FastAPI, TestClient, ConsoleEmailSender]]:
    sender = ConsoleEmailSender()
    app = create_app(
        make_settings(puzzle_source="generator", generator_processes=request.param),
        email_sender=sender,
        puzzle_source=GeneratorPuzzleSource(seed=2024),
    )
    Base.metadata.drop_all(app.state.engine)
    Base.metadata.create_all(app.state.engine)
    with TestClient(app, base_url="https://testserver") as client:
        yield app, client, sender
        Base.metadata.drop_all(app.state.engine)


def test_post_games_generates_a_real_puzzle(
    real_app: tuple[FastAPI, TestClient, ConsoleEmailSender],
) -> None:
    app, client, sender = real_app
    generator = app.state.puzzle_generator
    assert generator.uses_processes == (app.state.settings.generator_processes > 0)
    acc = make_account(client, sender.outbox, "gina")
    r = client.post(f"{API}/games", json={"difficulty": "easy"}, headers=acc.headers)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["difficulty"] == "easy"
    assert "solution" not in body
    with app.state.session_factory() as s:
        game = s.get(Game, body["id"])
        assert game is not None
        puzzle = game.puzzle
        assert puzzle.generator_version == version("sudoku-generator")
        assert puzzle.seed is not None
        assert puzzle.givens == body["givens"]
        report = pl.validate_puzzle(
            pl.parse(puzzle.givens), pl.parse(puzzle.solution), Difficulty.easy
        )
        assert report.is_valid
        assert puzzle.rating_score == report.rating.score
    # A real validator hint on a real generated puzzle.
    hint = client.post(f"{API}/games/{body['id']}/hint", json={"stage": 3}, headers=acc.headers)
    assert hint.status_code == 200
    assert hint.json()["value"] is not None


def test_generator_source_is_reproducible_with_a_seed() -> None:
    a = GeneratorPuzzleSource(seed=7)
    b = GeneratorPuzzleSource(seed=7)
    assert [a.get(Difficulty.easy) for _ in range(2)] == [b.get(Difficulty.easy) for _ in range(2)]


def test_refill_with_real_generator(app: FastAPI) -> None:
    added = pool.refill_pool(
        app.state.session_factory, GeneratorPuzzleSource(seed=3), 2, FAST_LEVELS, timeout=10
    )
    assert added == dict.fromkeys(FAST_LEVELS, 2)
