"""Puzzle storage, the pool, off-loop generation and the game service (mostly without HTTP)."""

from __future__ import annotations

import asyncio
import io
import json
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sudoku_api import cli
from sudoku_api.domain import Difficulty, GameStatus
from sudoku_api.errors import ApiError
from sudoku_api.main import create_app
from sudoku_api.models import Base, Game, Puzzle, PuzzlePool, User
from sudoku_api.services import games as game_service
from sudoku_api.services import generation, pool
from sudoku_api.services.email import ConsoleEmailSender
from sudoku_api.services.generation import PuzzleGenerator
from sudoku_api.services.puzzle_source import (
    _FIXTURES,
    FixturePuzzleSource,
    PuzzleGenerationError,
    SourcePuzzle,
)
from sudoku_api.workers import pool as pool_worker
from sudoku_api.workers.pool import refill_pool_async, run_pool_worker

from tests.conftest import API, make_account, make_settings

BAD_SOLUTION = "1" * 81


class StaticSource:
    """Always returns the same candidate (relabelled to the requested level)."""

    generator_version = "static"

    def __init__(self, candidate: SourcePuzzle) -> None:
        self.candidate = candidate
        self.calls: list[Difficulty] = []

    def get(self, difficulty: Difficulty, timeout: float | None = None) -> SourcePuzzle:
        self.calls.append(difficulty)
        return self.candidate._replace(difficulty=difficulty)


class RecordingSource(FixturePuzzleSource):
    def __init__(self, seed: int = 0) -> None:
        super().__init__(seed=seed)
        self.calls: list[Difficulty] = []

    def get(self, difficulty: Difficulty, timeout: float | None = None) -> SourcePuzzle:
        self.calls.append(difficulty)
        return super().get(difficulty, timeout)


class FailingSource:
    generator_version = "failing"

    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay

    def get(self, difficulty: Difficulty, timeout: float | None = None) -> SourcePuzzle:
        time.sleep(self.delay)
        raise PuzzleGenerationError("budget exhausted")


def _user(db: Session, name: str = "svc") -> User:
    user = User(username=name, email=f"{name}@example.com", password_hash="x")
    db.add(user)
    db.commit()
    return user


def _pool_total(app: FastAPI) -> int:
    with app.state.session_factory() as s:
        return int(s.scalar(select(func.count()).select_from(PuzzlePool)) or 0)


# --- storage & the validation gate ----------------------------------------------------------


def test_store_puzzle_validates(db: Session) -> None:
    good = FixturePuzzleSource(seed=3).get(Difficulty.easy)
    p, created = pool.store_puzzle(db, good, "test")
    assert created
    assert p.clue_count == sum(ch != "0" for ch in good.givens)
    assert p.validated_at is not None
    again, created_again = pool.store_puzzle(db, good, "test")  # same givens -> same row
    assert again.id == p.id
    assert not created_again
    with pytest.raises(pool.PuzzleRejectedError):
        pool.store_puzzle(db, good._replace(solution=BAD_SOLUTION), "test")
    with pytest.raises(pool.PuzzleRejectedError):
        pool.store_puzzle(db, good._replace(givens="12"), "test")


def test_duplicate_insert_from_another_session_is_harmless(app: FastAPI) -> None:
    """A row with the same givens committed concurrently must not raise (ON CONFLICT)."""
    good = FixturePuzzleSource(seed=8).get(Difficulty.medium)
    factory = app.state.session_factory
    with factory() as first, factory() as second:
        p1, created1 = pool.store_puzzle(first, good, "a")
        first.commit()
        p2, created2 = pool.store_puzzle(second, good, "b")
        second.commit()
    assert created1
    assert not created2
    assert p1.id == p2.id
    assert pool.add_to_pool_committed(factory, good, "c") is pool.AddResult.duplicate


def test_gate_stores_validator_rating_not_source_claim(db: Session) -> None:
    good = FixturePuzzleSource(seed=3).get(Difficulty.hard)
    lying = good._replace(rating_score=1, techniques={"Naked Single": 1})
    p, _ = pool.store_puzzle(db, lying, "test")
    assert p.rating_score == good.rating_score
    assert p.techniques == good.techniques


def test_gate_rejects_wrong_difficulty_and_logs(
    db: Session, caplog: pytest.LogCaptureFixture
) -> None:
    good = FixturePuzzleSource(seed=3).get(Difficulty.easy)
    with caplog.at_level("WARNING", logger="sudoku_api"), pytest.raises(pool.PuzzleRejectedError):
        pool.store_puzzle(db, good._replace(difficulty=Difficulty.extreme), "test")
    assert "rejected puzzle" in caplog.text
    assert db.scalar(select(func.count()).select_from(Puzzle)) == 0


# --- refill ---------------------------------------------------------------------------------


def test_refill_tops_up_each_level(app: FastAPI) -> None:
    factory = app.state.session_factory
    added = pool.refill_pool(factory, FixturePuzzleSource(seed=5), target_per_level=3)
    assert added == dict.fromkeys(Difficulty, 3)
    again = pool.refill_pool(factory, FixturePuzzleSource(seed=6), target_per_level=3)
    assert set(again.values()) == {0}
    with factory() as s:
        assert pool.pool_counts(s) == dict.fromkeys(Difficulty, 3)


def test_refill_fills_emptiest_level_first(app: FastAPI) -> None:
    factory = app.state.session_factory
    pool.refill_pool(factory, FixturePuzzleSource(seed=1), 2, [Difficulty.easy])
    pool.refill_pool(factory, FixturePuzzleSource(seed=2), 1, [Difficulty.hard])
    source = RecordingSource(seed=3)
    pool.refill_pool(factory, source, 2, [Difficulty.easy, Difficulty.hard, Difficulty.master])
    # master (0) first, then hard (1) and master again alternate by count, easy is full.
    assert source.calls == [Difficulty.master, Difficulty.hard, Difficulty.master]


def test_refill_skips_invalid_and_duplicate_puzzles(app: FastAPI) -> None:
    factory = app.state.session_factory
    good = FixturePuzzleSource(seed=1).get(Difficulty.easy)
    bad = StaticSource(good._replace(solution=BAD_SOLUTION))
    assert pool.refill_pool(factory, bad, 2, [Difficulty.easy]) == {Difficulty.easy: 0}
    assert len(bad.calls) == pool.MAX_FAILURES_PER_LEVEL
    dup = StaticSource(good)
    assert pool.refill_pool(factory, dup, 3, [Difficulty.easy]) == {Difficulty.easy: 1}
    with factory() as s:
        assert s.scalar(select(func.count()).select_from(Puzzle)) == 1


def test_refill_survives_generation_errors(app: FastAPI) -> None:
    added = pool.refill_pool(app.state.session_factory, FailingSource(), 2, [Difficulty.easy])
    assert added == {Difficulty.easy: 0}


def test_level_without_fixtures_is_skipped(app: FastAPI) -> None:
    source = FixturePuzzleSource(fixtures={Difficulty.easy: _FIXTURES[Difficulty.easy]})
    added = pool.refill_pool(app.state.session_factory, source, 2)
    assert added[Difficulty.easy] == 2
    assert added[Difficulty.master] == 0


# --- game creation --------------------------------------------------------------------------


def test_game_uses_pool_then_needs_a_candidate(app: FastAPI, db: Session) -> None:
    factory = app.state.session_factory
    pool.refill_pool(factory, FixturePuzzleSource(seed=9), 1, [Difficulty.hard])
    pooled_id = db.scalar(select(PuzzlePool.puzzle_id))
    user = _user(db)
    g1 = game_service.create_game(db, user, Difficulty.hard)
    assert g1 is not None
    assert g1.puzzle_id == pooled_id
    assert pool.pool_size(db, Difficulty.hard) == 0
    # Pool empty: nothing changes (the current game is NOT abandoned) until a candidate exists.
    assert game_service.create_game(db, user, Difficulty.hard) is None
    db.refresh(g1)
    assert g1.status == GameStatus.in_progress
    candidate = FixturePuzzleSource(seed=10).get(Difficulty.hard)
    g2 = game_service.create_game(
        db, user, Difficulty.hard, candidate=candidate, generator_version="x"
    )
    assert g2 is not None
    assert g2.puzzle.givens == candidate.givens
    assert g2.puzzle.generator_version == "x"
    db.refresh(g1)
    assert g1.status == GameStatus.abandoned


def test_unused_candidate_goes_into_the_pool(app: FastAPI, db: Session) -> None:
    pool.refill_pool(app.state.session_factory, FixturePuzzleSource(seed=4), 1, [Difficulty.easy])
    candidate = FixturePuzzleSource(seed=44).get(Difficulty.easy)
    game = game_service.create_game(db, _user(db), Difficulty.easy, candidate=candidate)
    assert game is not None
    assert game.puzzle.givens != candidate.givens  # took the pooled one
    assert pool.pool_size(db, Difficulty.easy) == 1  # candidate kept for the next player


def test_invalid_candidate_is_503(db: Session) -> None:
    good = FixturePuzzleSource(seed=1).get(Difficulty.easy)
    with pytest.raises(ApiError) as exc:
        game_service.create_game(
            db, _user(db), Difficulty.easy, candidate=good._replace(solution=BAD_SOLUTION)
        )
    assert exc.value.status_code == 503
    assert exc.value.code == "puzzle_unavailable"


def test_skip_locked_only_on_postgres(db: Session) -> None:
    stmt = pool._claim_candidates(db, Difficulty.easy)
    if db.get_bind().dialect.name != "postgresql":
        assert "FOR UPDATE" not in str(stmt.compile(dialect=sqlite.dialect()))

    class FakeBind:
        dialect = postgresql.dialect()  # type: ignore[no-untyped-call]

    class FakeSession:
        def get_bind(self) -> FakeBind:
            return FakeBind()

    pg = pool._claim_candidates(FakeSession(), Difficulty.easy)  # type: ignore[arg-type]
    assert "FOR UPDATE SKIP LOCKED" in str(pg.compile(dialect=postgresql.dialect()))  # type: ignore[no-untyped-call]


def test_one_in_progress_game_per_user_enforced_by_db(db: Session) -> None:
    user = _user(db)
    candidate = FixturePuzzleSource(seed=2).get(Difficulty.easy)
    g = game_service.create_game(db, user, Difficulty.easy, candidate=candidate)
    assert g is not None
    db.add(
        Game(
            user_id=user.id,
            puzzle_id=g.puzzle_id,
            status=str(GameStatus.in_progress),
            current=g.current,
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()


# --- off-loop generation, worker and HTTP fallback -------------------------------------------


def test_generator_timeout_becomes_source_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(generation, "TIMEOUT_GRACE_SECONDS", 0.0)
    gen = PuzzleGenerator(FailingSource(delay=0.5))

    async def scenario() -> None:
        with pytest.raises(PuzzleGenerationError, match="longer than"):
            await gen.get(Difficulty.easy, timeout=0.05)

    asyncio.run(scenario())


def test_async_refill_and_worker(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    """Deterministic: waits for the worker's first completed pass (an event), not wall time."""
    gen = PuzzleGenerator(FixturePuzzleSource(seed=4))
    passes: list[dict[Difficulty, int]] = []

    async def scenario() -> None:
        added = await refill_pool_async(app.state.session_factory, gen, 1)
        assert added == dict.fromkeys(Difficulty, 1)

        pass_done = asyncio.Event()

        async def observed_refill(*args: Any, **kwargs: Any) -> dict[Difficulty, int]:
            result = await refill_pool_async(*args, **kwargs)
            passes.append(result)
            pass_done.set()
            return result

        monkeypatch.setattr(pool_worker, "refill_pool_async", observed_refill)
        task = asyncio.create_task(run_pool_worker(app.state.session_factory, gen, 2, 3600))
        # Hang guard only; the event fires as soon as the first pass completes.
        await asyncio.wait_for(pass_done.wait(), timeout=120)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert passes == [dict.fromkeys(Difficulty, 1)]
    assert _pool_total(app) == 2 * len(Difficulty)


@pytest.fixture
def app_with_source(
    request: pytest.FixtureRequest,
) -> Iterator[tuple[TestClient, ConsoleEmailSender]]:
    sender = ConsoleEmailSender()
    application = create_app(make_settings(), email_sender=sender, puzzle_source=request.param)
    Base.metadata.drop_all(application.state.engine)
    Base.metadata.create_all(application.state.engine)
    with TestClient(application, base_url="https://testserver") as client:
        yield client, sender
        Base.metadata.drop_all(application.state.engine)


@pytest.mark.parametrize(
    "app_with_source",
    [FixturePuzzleSource(fixtures={Difficulty.easy: _FIXTURES[Difficulty.easy]})],
    indirect=True,
)
def test_level_without_puzzles_returns_503(
    app_with_source: tuple[TestClient, ConsoleEmailSender],
) -> None:
    client, sender = app_with_source
    acc = make_account(client, sender.outbox, "erin")
    r = client.post(f"{API}/games", json={"difficulty": "master"}, headers=acc.headers)
    assert r.status_code == 503
    assert r.json() == {
        "detail": "Could not produce a puzzle, please retry",
        "code": "puzzle_unavailable",
    }
    ok = client.post(f"{API}/games", json={"difficulty": "easy"}, headers=acc.headers)
    assert ok.status_code == 201


@pytest.mark.parametrize("app_with_source", [FailingSource()], indirect=True)
def test_generation_failure_returns_503_and_keeps_current_game(
    app_with_source: tuple[TestClient, ConsoleEmailSender],
) -> None:
    client, sender = app_with_source
    acc = make_account(client, sender.outbox, "fay")
    r = client.post(f"{API}/games", json={"difficulty": "easy"}, headers=acc.headers)
    assert r.status_code == 503
    assert r.json()["code"] == "puzzle_unavailable"
    assert client.get(f"{API}/games/current", headers=acc.headers).status_code == 404


# --- seed-pool CLI --------------------------------------------------------------------------


def _row(p: SourcePuzzle) -> str:
    return json.dumps(
        {
            "givens": p.givens,
            "solution": p.solution,
            "difficulty": str(p.difficulty),
            "score": p.rating_score,
            "techniques": p.techniques,
            "clue_count": sum(c != "0" for c in p.givens),
            "seed": 123,
        }
    )


def test_seed_pool_cli(tmp_path: Path) -> None:
    from alembic import command

    from tests.test_migrations import _config

    url = f"sqlite:///{tmp_path / 'seed.db'}"
    command.upgrade(_config(url), "head")
    src = FixturePuzzleSource(seed=11)
    easy, hard = src.get(Difficulty.easy), src.get(Difficulty.hard)
    lines = [
        _row(easy),
        _row(hard),
        _row(easy),  # duplicate
        _row(hard._replace(difficulty=Difficulty.beginner)),  # mislabelled -> rejected
        "{not json",
        "",
    ]
    data = tmp_path / "puzzles.jsonl"
    data.write_text("\n".join(lines) + "\n")
    out = io.StringIO()
    import contextlib

    with contextlib.redirect_stdout(out):
        code = cli.main(["seed-pool", str(data), "--database-url", url, "--generator-version", "9"])
    assert code == 1
    text = out.getvalue()
    assert "added=2, duplicate=1, rejected=1, malformed=1" in text
    assert "line 4: rejected" in text
    assert "line 5: malformed" in text

    from sudoku_api.db import make_engine, make_session_factory

    engine = make_engine(url)
    with make_session_factory(engine)() as s:
        counts = pool.pool_counts(s)
        assert counts[Difficulty.easy] == 1
        assert counts[Difficulty.hard] == 1
        stored = s.scalars(select(Puzzle)).all()
        assert {p.seed for p in stored} == {123}
        assert {p.generator_version for p in stored} == {"9"}
    engine.dispose()


def test_worker_disabled_in_test_settings() -> None:
    settings = make_settings()
    assert settings.pool_worker_enabled is False
    assert settings.generator_processes == 0
