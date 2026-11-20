"""Photo import (PLAN.md §5.6): contract, /imports/check, /games/import, /imports/recognize."""

from __future__ import annotations

import json
import logging
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sudoku_api.config import Settings
from sudoku_api.domain import Difficulty
from sudoku_api.models import Puzzle, PuzzlePool
from sudoku_api.services import puzzle_logic, recognition
from sudoku_api.services.puzzle_source import _FIXTURES
from sudoku_api.uploads import MAX_BODY_BYTES
from sudoku_vision import CellReading, Recognition, RecognitionError

from tests.conftest import API, Account, make_settings, solution_of

VISION_FIXTURES = Path(__file__).resolve().parents[2] / "vision" / "tests" / "fixtures"

EASY_GIVENS, EASY_SOLUTION = _FIXTURES[Difficulty.easy][0]
HARD_GIVENS, HARD_SOLUTION = _FIXTURES[Difficulty.hard][0]
EMPTY = "0" * 81
# Consistent but unsolvable: r1c9 has no candidate (1-8 in row 1, 9 below it in column 9).
NO_SOLUTION = "123456780" + "000000009" + "0" * 63
INCONSISTENT = "11" + "0" * 79
NULLABLE_DIFFICULTY = [{"$ref": "#/components/schemas/Difficulty"}, {"type": "null"}]
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def settings() -> Settings:
    return make_settings(recognition_timeout_seconds=2, import_rating_timeout_seconds=2)


def _board(givens: str, current: str | None = None) -> dict[str, str]:
    return {"givens": givens, "current": current or givens}


def _check(client: TestClient, acc: Account, givens: str, current: str | None = None) -> Any:
    r = client.post(f"{API}/imports/check", json=_board(givens, current), headers=acc.headers)
    assert r.status_code == 200, r.text
    return r


def _import(client: TestClient, acc: Account, givens: str, current: str | None = None) -> Any:
    return client.post(f"{API}/games/import", json=_board(givens, current), headers=acc.headers)


def _set(grid: str, cell: int, digit: int) -> str:
    return grid[:cell] + str(digit) + grid[cell + 1 :]


def _right_and_wrong_entry(givens: str, solution: str) -> tuple[str, str]:
    """Two boards differing in one handwritten cell: correct vs wrong, both contradiction-free."""
    for cell, g in enumerate(givens):
        if g != "0":
            continue
        for d in range(1, 10):
            if str(d) == solution[cell]:
                continue
            wrong = _set(givens, cell, d)
            if puzzle_logic.find_contradiction(puzzle_logic.parse(wrong)) is None:
                return _set(givens, cell, int(solution[cell])), wrong
    raise AssertionError("no silent wrong entry found")


# ---------------------------------------------------------------- contract


def test_contract_schemas(app: FastAPI) -> None:
    spec = app.openapi()
    s = spec["components"]["schemas"]
    assert set(s["RecognitionOut"]["properties"]) == {
        "corners", "image_size", "cells", "grid_confidence", "warnings",
    }  # fmt: skip
    assert set(s["CellReadingOut"]["properties"]) == {
        "index", "digit", "kind", "confidence", "alternatives", "auto_corrected",
    }  # fmt: skip
    assert set(s["DigitAlternative"]["properties"]) == {"digit", "p"}
    assert set(s["ImageSize"]["properties"]) == {"width", "height"}
    assert set(s["RecognizeImportForm"]["properties"]) == {"file", "corners"}
    assert set(s["ImportBoardIn"]["properties"]) == {"givens", "current"}
    assert set(s["ImportCheckOut"]["properties"]) == {
        "consistent", "contradiction", "solution_count", "difficulty", "rating_score",
    }  # fmt: skip
    for name in ("RecognitionOut", "CellReadingOut", "ImportCheckOut", "GameOut"):
        assert "solution" not in s[name]["properties"]
    assert s["GameOut"]["properties"]["difficulty"]["anyOf"] == NULLABLE_DIFFICULTY
    assert s["ScoreHistoryItem"]["properties"]["difficulty"]["anyOf"] == NULLABLE_DIFFICULTY
    body = spec["paths"][f"{API}/imports/recognize"]["post"]["requestBody"]
    assert body["content"]["multipart/form-data"]["schema"]["$ref"].endswith("/RecognizeImportForm")


def test_declared_statuses(app: FastAPI) -> None:
    paths = app.openapi()["paths"]

    def codes(path: str) -> set[str]:
        return set(paths[f"{API}{path}"]["post"]["responses"])

    assert codes("/imports/recognize") == {"200", "401", "413", "415", "422", "429", "503"}
    assert codes("/imports/check") == {"200", "401", "422", "429"}
    assert codes("/games/import") == {"201", "401", "422", "429"}


def test_endpoints_require_auth(client: TestClient) -> None:
    files = {"file": ("grid.png", PNG, "image/png")}
    assert client.post(f"{API}/imports/recognize", files=files).status_code == 401
    assert client.post(f"{API}/imports/check", json=_board(EASY_GIVENS)).status_code == 401
    assert client.post(f"{API}/games/import", json=_board(EASY_GIVENS)).status_code == 401


# ---------------------------------------------------------------- /imports/check


def test_check_unique_puzzle_is_rated(client: TestClient, alice: Account) -> None:
    body = _check(client, alice, HARD_GIVENS).json()
    assert body == {
        "consistent": True,
        "contradiction": None,
        "solution_count": 1,
        "difficulty": "hard",
        "rating_score": body["rating_score"],
    }
    assert isinstance(body["rating_score"], int)


@pytest.mark.parametrize(("givens", "count"), [(EMPTY, 2), (NO_SOLUTION, 0), (INCONSISTENT, 0)])
def test_check_solution_counts(client: TestClient, alice: Account, givens: str, count: int) -> None:
    body = _check(client, alice, givens).json()
    assert body["solution_count"] == count
    assert body["difficulty"] is None
    assert body["rating_score"] is None


def test_check_reports_contradiction_in_current(client: TestClient, alice: Account) -> None:
    body = _check(client, alice, INCONSISTENT).json()
    assert body["consistent"] is False
    assert body["contradiction"]["kind"] == "duplicate"
    assert body["contradiction"]["cells"] == [0, 1]


def test_check_never_reveals_solution_or_entry_correctness(
    client: TestClient, alice: Account
) -> None:
    right, wrong = _right_and_wrong_entry(EASY_GIVENS, EASY_SOLUTION)
    r_right = _check(client, alice, EASY_GIVENS, right)
    r_wrong = _check(client, alice, EASY_GIVENS, wrong)
    assert r_right.json() == r_wrong.json()
    for r in (r_right, r_wrong):
        assert EASY_SOLUTION not in r.text
        assert "solution" not in r.json()


def test_check_rejects_modified_givens(client: TestClient, alice: Account) -> None:
    cell = next(i for i, g in enumerate(EASY_GIVENS) if g != "0")
    modified = _set(EASY_GIVENS, cell, 0)
    r = client.post(
        f"{API}/imports/check", json=_board(EASY_GIVENS, modified), headers=alice.headers
    )
    assert r.status_code == 422
    assert r.json()["code"] == "givens_modified"


def test_check_validates_grid_format(client: TestClient, alice: Account) -> None:
    r = client.post(f"{API}/imports/check", json=_board("x" * 81, EMPTY), headers=alice.headers)
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


def test_check_skips_rating_unless_unique(
    client: TestClient, alice: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(givens: str) -> puzzle_logic.GivensRating:
        raise AssertionError("rate_givens must not run")

    monkeypatch.setattr(puzzle_logic, "rate_givens", boom)
    assert _check(client, alice, EMPTY).json()["solution_count"] == 2


@pytest.fixture
def release() -> Iterator[threading.Event]:
    """Fake jobs block on this event, so a timeout always fires first (no wall-clock race).
    Set after the assertions, and again on teardown so no worker thread is left blocked."""
    event = threading.Event()
    yield event
    event.set()


def _blocked_rating(release: threading.Event) -> Any:
    def blocked(givens: str) -> puzzle_logic.GivensRating:
        release.wait(30)  # hang guard only
        return puzzle_logic.GivensRating(True, "hard", 1, {})

    return blocked


def test_check_rating_timeout_gives_null_difficulty(
    app: FastAPI,
    client: TestClient,
    alice: Account,
    monkeypatch: pytest.MonkeyPatch,
    release: threading.Event,
) -> None:
    app.state.settings.import_rating_timeout_seconds = 0.05
    monkeypatch.setattr(puzzle_logic, "rate_givens", _blocked_rating(release))
    body = _check(client, alice, HARD_GIVENS).json()
    release.set()
    assert body["solution_count"] == 1
    assert body["difficulty"] is None
    assert body["rating_score"] is None


# ---------------------------------------------------------------- /games/import


def test_import_starts_game_with_handwritten_entries(
    app: FastAPI, client: TestClient, alice: Account
) -> None:
    _right, wrong = _right_and_wrong_entry(EASY_GIVENS, EASY_SOLUTION)
    r = _import(client, alice, EASY_GIVENS, wrong)
    assert r.status_code == 201, r.text
    game = r.json()
    assert game["source"] == "imported"
    assert game["difficulty"] == "easy"
    assert game["status"] == "in_progress"
    assert game["givens"] == EASY_GIVENS
    assert game["current"] == wrong
    assert game["mistakes"] == 0
    assert "solution" not in game
    assert EASY_SOLUTION not in r.text
    assert solution_of(app, game["id"]) == EASY_SOLUTION
    resumed = client.get(f"{API}/games/current", headers=alice.headers).json()
    assert resumed["id"] == game["id"]
    assert EASY_SOLUTION not in str(resumed)


@pytest.mark.parametrize(
    ("givens", "code"),
    [
        (INCONSISTENT, "puzzle_inconsistent"),
        (NO_SOLUTION, "no_solution"),
        (EMPTY, "multiple_solutions"),
    ],
)
def test_import_rejects_bad_puzzles(
    client: TestClient, alice: Account, givens: str, code: str
) -> None:
    r = _import(client, alice, givens)
    assert r.status_code == 422
    assert r.json()["code"] == code


def test_import_rejects_modified_givens(client: TestClient, alice: Account) -> None:
    cell = next(i for i, g in enumerate(EASY_GIVENS) if g != "0")
    r = _import(client, alice, EASY_GIVENS, _set(EASY_GIVENS, cell, 0))
    assert r.status_code == 422
    assert r.json()["code"] == "givens_modified"


def test_import_abandons_current_game(client: TestClient, alice: Account) -> None:
    first = client.post(f"{API}/games", json={"difficulty": "easy"}, headers=alice.headers)
    imported = _import(client, alice, HARD_GIVENS).json()
    old = client.get(f"{API}/games/{first.json()['id']}", headers=alice.headers).json()
    assert old["status"] == "abandoned"
    assert client.get(f"{API}/games/current", headers=alice.headers).json()["id"] == imported["id"]


def test_import_reuses_puzzle_rows_and_never_pools(
    app: FastAPI, client: TestClient, alice: Account, bob: Account
) -> None:
    generated = client.post(f"{API}/games", json={"difficulty": "easy"}, headers=alice.headers)
    givens = generated.json()["givens"]
    a = _import(client, bob, givens).json()  # same givens as a generated row: reused
    b = _import(client, alice, HARD_GIVENS).json()
    c = _import(client, bob, HARD_GIVENS).json()  # same imported row again
    assert a["source"] == b["source"] == c["source"] == "imported"
    with app.state.session_factory() as s:
        assert s.scalar(select(func.count()).select_from(Puzzle)) == 2
        imported = s.scalar(select(Puzzle).where(Puzzle.givens == HARD_GIVENS))
        assert imported is not None
        assert imported.source == "imported"
        assert imported.generator_version == "import"
        assert s.scalar(select(func.count()).select_from(PuzzlePool)) == 0


def _puzzle_row(app: FastAPI, givens: str) -> Puzzle:
    with app.state.session_factory() as s:
        puzzle = s.scalar(select(Puzzle).where(Puzzle.givens == givens))
        assert puzzle is not None
        s.expunge(puzzle)
        return puzzle


def test_import_removes_reused_puzzle_from_pool(
    app: FastAPI, client: TestClient, alice: Account
) -> None:
    from sudoku_api.services.pool import AddResult, add_to_pool
    from sudoku_api.services.puzzle_source import SourcePuzzle

    candidate = SourcePuzzle(HARD_GIVENS, HARD_SOLUTION, Difficulty.hard, 0, {}, None)
    with app.state.session_factory() as s:
        assert add_to_pool(s, candidate, "test") is AddResult.added
        s.commit()
    game = _import(client, alice, HARD_GIVENS).json()
    assert game["source"] == "imported"
    with app.state.session_factory() as s:
        assert s.scalar(select(func.count()).select_from(PuzzlePool)) == 0
    assert _puzzle_row(app, HARD_GIVENS).source == "generated"  # the row itself is kept

    # Nor can the generator's synchronous fallback hand the same givens out as ranked.
    from sudoku_api.errors import ApiError
    from sudoku_api.models import User
    from sudoku_api.services import games as game_service

    with app.state.session_factory() as s:
        user = s.scalar(select(User).where(User.username == "alice"))
        assert user is not None
        with pytest.raises(ApiError) as exc:
            game_service.create_game(s, user, Difficulty.hard, candidate=candidate)
        assert exc.value.status_code == 503


def test_rating_timeout_is_provisional_and_rerated_on_reuse(
    app: FastAPI,
    client: TestClient,
    alice: Account,
    bob: Account,
    monkeypatch: pytest.MonkeyPatch,
    release: threading.Event,
) -> None:
    app.state.settings.import_rating_timeout_seconds = 0.05
    real = puzzle_logic.rate_givens
    monkeypatch.setattr(puzzle_logic, "rate_givens", _blocked_rating(release))
    first = _import(client, alice, HARD_GIVENS)
    release.set()
    assert first.status_code == 201, first.text
    assert first.json()["difficulty"] is None
    pending = _puzzle_row(app, HARD_GIVENS)
    assert (pending.difficulty, pending.rating_score) == (None, None)  # pending, not Unrated

    monkeypatch.setattr(puzzle_logic, "rate_givens", real)
    second = _import(client, bob, HARD_GIVENS).json()
    assert second["difficulty"] == "hard"
    rated = _puzzle_row(app, HARD_GIVENS)
    assert rated.id == pending.id
    assert rated.difficulty == "hard"
    assert rated.rating_score is not None
    # Alice's game uses the same row, so it now shows the final rating too.
    assert client.get(f"{API}/games/current", headers=alice.headers).json()["difficulty"] == "hard"

    def must_not_rate(givens: str) -> puzzle_logic.GivensRating:
        raise AssertionError("a finally rated row is reused without re-rating")

    monkeypatch.setattr(puzzle_logic, "rate_givens", must_not_rate)
    assert _import(client, alice, HARD_GIVENS).status_code == 201


def test_genuinely_unrated_import_stays_unrated(
    app: FastAPI, client: TestClient, alice: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = puzzle_logic.rate_givens
    monkeypatch.setattr(puzzle_logic, "rate_givens", lambda g: real(g)._replace(difficulty=None))
    assert _import(client, alice, HARD_GIVENS).json()["difficulty"] is None
    row = _puzzle_row(app, HARD_GIVENS)
    assert row.difficulty is None
    assert row.rating_score is not None  # final: Unrated, not pending

    def must_not_rate(givens: str) -> puzzle_logic.GivensRating:
        raise AssertionError("Unrated is final; no re-rating")

    monkeypatch.setattr(puzzle_logic, "rate_givens", must_not_rate)
    assert _import(client, alice, HARD_GIVENS).json()["difficulty"] is None


def test_unrated_import_scores_as_expert_with_45_minute_par(
    app: FastAPI, client: TestClient, alice: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = puzzle_logic.rate_givens
    monkeypatch.setattr(puzzle_logic, "rate_givens", lambda g: real(g)._replace(difficulty=None))
    game = _import(client, alice, HARD_GIVENS).json()
    assert game["difficulty"] is None
    r = client.post(
        f"{API}/games/{game['id']}/complete",
        json={"current": HARD_SOLUTION, "notes": {}, "elapsed_seconds": 60, "version": 1},
        headers=alice.headers,
    )
    assert r.status_code == 200, r.text
    breakdown = r.json()["score_breakdown"]
    assert breakdown["base"] == 1000
    assert breakdown["par_seconds"] == 45 * 60
    assert r.json()["difficulty"] is None


# ---------------------------------------------------------------- leaderboard / history


def _complete(client: TestClient, acc: Account, game: dict[str, Any], solution: str) -> None:
    r = client.post(
        f"{API}/games/{game['id']}/complete",
        json={"current": solution, "notes": {}, "elapsed_seconds": 30, "version": game["version"]},
        headers=acc.headers,
    )
    assert r.status_code == 200, r.text


def test_imported_games_never_ranked_but_in_history(
    app: FastAPI, client: TestClient, alice: Account
) -> None:
    game = _import(client, alice, HARD_GIVENS).json()
    _complete(client, alice, game, HARD_SOLUTION)

    for params in ({}, {"difficulty": "hard"}):
        board = client.get(f"{API}/leaderboard", params=params).json()
        assert board["entries"] == []
    me = client.get(f"{API}/leaderboard/me", headers=alice.headers).json()
    assert me["rank"] is None
    assert me["total"] == 0

    scores = client.get(f"{API}/scores/me", headers=alice.headers).json()
    assert scores["history"][0]["source"] == "imported"
    assert scores["history"][0]["difficulty"] == "hard"
    assert [b["difficulty"] for b in scores["best"]] == ["hard"]


def test_import_of_generated_givens_is_still_unranked(
    app: FastAPI, client: TestClient, alice: Account, bob: Account
) -> None:
    """Pre-solving a known generated puzzle offline and importing it must not rank."""
    generated = client.post(f"{API}/games", json={"difficulty": "easy"}, headers=alice.headers)
    givens = generated.json()["givens"]
    game = _import(client, bob, givens).json()
    _complete(client, bob, game, solution_of(app, game["id"]))
    assert client.get(f"{API}/leaderboard").json()["entries"] == []


def test_generated_games_still_ranked(app: FastAPI, client: TestClient, alice: Account) -> None:
    game = client.post(f"{API}/games", json={"difficulty": "easy"}, headers=alice.headers).json()
    _complete(client, alice, game, solution_of(app, game["id"]))
    entries = client.get(f"{API}/leaderboard").json()["entries"]
    assert [e["username"] for e in entries] == ["alice"]
    history = client.get(f"{API}/scores/me", headers=alice.headers).json()["history"]
    assert history[0]["source"] == "generated"


# ---------------------------------------------------------------- /imports/recognize


def _reading(index: int, digit: int, kind: str = "given") -> CellReading:
    if digit == 0:
        return CellReading(index, 0, "empty", 0.99, (), False)
    return CellReading(
        index,
        digit,
        kind,
        0.93,
        ((digit, 0.93), (0, 0.04), (7, 0.02)),
        index == 1,  # type: ignore[arg-type]
    )


FAKE = Recognition(
    corners=((10.0, 12.0), (500.0, 11.0), (505.0, 498.0), (8.0, 502.0)),
    image_size=(640, 520),
    cells=tuple(_reading(i, int(d)) for i, d in enumerate(EASY_GIVENS)),
    grid_confidence=0.97,
    warnings=("givens have multiple solutions",),
)


@pytest.fixture
def fake_vision(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    calls: list[Any] = []

    def fake(image: bytes, corners: Any) -> Recognition:
        calls.append((image, corners))
        return FAKE

    monkeypatch.setattr(recognition, "vision_recognize", fake)
    return calls


def _upload(
    client: TestClient,
    acc: Account | None,
    image: bytes = PNG,
    corners: str | None = None,
    **kwargs: Any,
) -> Any:
    data = {} if corners is None else {"corners": corners}
    return client.post(
        f"{API}/imports/recognize",
        files={"file": ("grid.png", image, "image/png")},
        data=data,
        headers=acc.headers if acc else {},
        **kwargs,
    )


def test_recognize_returns_readings(
    client: TestClient, alice: Account, fake_vision: list[Any]
) -> None:
    r = _upload(client, alice)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["corners"] == [[10.0, 12.0], [500.0, 11.0], [505.0, 498.0], [8.0, 502.0]]
    assert body["image_size"] == {"width": 640, "height": 520}
    assert len(body["cells"]) == 81
    assert body["grid_confidence"] == 0.97
    assert body["warnings"] == ["givens have multiple solutions"]
    filled = next(c for c in body["cells"] if c["digit"])
    # Alternatives are `{digit, p}` and never include 0 (empty).
    assert filled["alternatives"] == [
        {"digit": filled["digit"], "p": 0.93},
        {"digit": 7, "p": 0.02},
    ]
    assert body["cells"][1]["auto_corrected"] is True
    assert fake_vision == [(PNG, None)]


def test_recognize_passes_corners(
    client: TestClient, alice: Account, fake_vision: list[Any]
) -> None:
    r = _upload(client, alice, corners="[[1,2],[3.5,4],[5,6],[7,8]]")
    assert r.status_code == 200, r.text
    assert fake_vision[0][1] == ((1.0, 2.0), (3.5, 4.0), (5.0, 6.0), (7.0, 8.0))


@pytest.mark.parametrize(
    "corners",
    ["nope", "[[1,2],[3,4],[5,6]]", '[[1,2],[3,4],[5,6],[7,"x"]]', "[[1,2],[3,4],[5,6],[7,true]]"],
)
def test_recognize_rejects_bad_corners(
    client: TestClient, alice: Account, fake_vision: list[Any], corners: str
) -> None:
    r = _upload(client, alice, corners=corners)
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"
    assert fake_vision == []


def test_recognize_requires_file(client: TestClient, alice: Account) -> None:
    r = client.post(
        f"{API}/imports/recognize", data={"corners": "[]"}, files={}, headers=alice.headers
    )
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("image_too_large", 413),
        ("unsupported_image", 415),
        ("image_unreadable", 422),
        ("no_grid_found", 422),
    ],
)
def test_recognition_errors_map_to_http(
    client: TestClient,
    alice: Account,
    monkeypatch: pytest.MonkeyPatch,
    code: str,
    status: int,
) -> None:
    def fail(image: bytes, corners: Any) -> Recognition:
        raise RecognitionError(code)  # type: ignore[arg-type]

    monkeypatch.setattr(recognition, "vision_recognize", fail)
    r = _upload(client, alice)
    assert r.status_code == status
    assert r.json()["code"] == code


def test_real_vision_rejects_non_images(client: TestClient, alice: Account) -> None:
    """The real `sudoku_vision` decoder (no model needed to reject bytes)."""
    r = _upload(client, alice, image=b"definitely not an image")
    assert r.status_code == 415
    assert r.json()["code"] == "unsupported_image"


def test_recognition_crash_is_503_and_image_never_logged(
    client: TestClient,
    alice: Account,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    marker = b"PRIVATE-PIXELS-1234"

    def crash(image: bytes, corners: Any) -> Recognition:
        raise RuntimeError(f"model exploded on {image!r}")

    monkeypatch.setattr(recognition, "vision_recognize", crash)
    with caplog.at_level(logging.DEBUG):
        r = _upload(client, alice, image=PNG + marker)
    assert r.status_code == 503
    assert r.json()["code"] == "recognition_unavailable"
    assert marker.decode() not in r.text
    assert marker.decode() not in caplog.text
    assert "RuntimeError" in caplog.text


def test_recognition_timeout_is_503(
    app: FastAPI,
    client: TestClient,
    alice: Account,
    monkeypatch: pytest.MonkeyPatch,
    release: threading.Event,
) -> None:
    app.state.settings.recognition_timeout_seconds = 0.05

    def blocked(image: bytes, corners: Any) -> Recognition:
        release.wait(30)  # hang guard only
        return FAKE

    monkeypatch.setattr(recognition, "vision_recognize", blocked)
    r = _upload(client, alice)
    release.set()
    assert r.status_code == 503
    assert r.json()["code"] == "recognition_unavailable"


def test_upload_over_limit_rejected_by_content_length(
    client: TestClient, alice: Account, fake_vision: list[Any]
) -> None:
    r = _upload(client, alice, image=b"\0" * (recognition.MAX_IMAGE_BYTES + 1))
    assert r.status_code == 413
    assert r.json()["code"] == "image_too_large"
    assert fake_vision == []


def test_upload_over_limit_rejected_while_streaming(
    client: TestClient, alice: Account, fake_vision: list[Any]
) -> None:
    """Without Content-Length the body is counted while parsing and cut off at the limit."""
    boundary = "b0undary"
    chunk = 1024 * 1024

    def body() -> Iterator[bytes]:
        yield (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            f'filename="g.png"\r\nContent-Type: image/png\r\n\r\n'
        ).encode()
        for _ in range(64):  # 64 MB if fully read
            yield b"\0" * chunk
        yield f"\r\n--{boundary}--\r\n".encode()

    r = client.post(
        f"{API}/imports/recognize",
        content=body(),
        headers={**alice.headers, "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    assert r.status_code == 413
    assert r.json()["code"] == "image_too_large"
    assert fake_vision == []


def test_limited_form_stops_reading_at_the_limit() -> None:
    """Server side: the parser stops pulling body chunks once the limit is passed."""
    import asyncio

    from starlette.requests import Request
    from sudoku_api.errors import ApiError
    from sudoku_api.uploads import read_limited_form

    boundary = "b0undary"
    chunk = 1024 * 1024
    head = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="g.png"\r\nContent-Type: image/png\r\n\r\n'
    ).encode()
    received = 0

    async def receive() -> dict[str, Any]:
        nonlocal received
        received += chunk
        body = head if received == chunk else b"\0" * chunk
        return {"type": "http.request", "body": body, "more_body": received < 64 * chunk}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(b"content-type", f"multipart/form-data; boundary={boundary}".encode())],
    }
    with pytest.raises(ApiError) as exc:
        asyncio.run(read_limited_form(Request(scope, receive)))
    assert exc.value.status_code == 413
    assert received <= MAX_BODY_BYTES + 2 * chunk  # far below the 64 MB on offer


def test_upload_is_never_spooled_to_disk(
    client: TestClient, alice: Account, fake_vision: list[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_disk(self: Any) -> None:
        raise AssertionError("upload rolled over to a temporary file on disk")

    monkeypatch.setattr(tempfile.SpooledTemporaryFile, "rollover", no_disk)
    image = PNG + b"\0" * (3 * 1024 * 1024)  # above Starlette's 1 MB default spool size
    r = _upload(client, alice, image=image)
    assert r.status_code == 200, r.text
    assert fake_vision[0][0] == image


def test_recognize_rejects_non_multipart(client: TestClient, alice: Account) -> None:
    r = client.post(f"{API}/imports/recognize", json={"file": "x"}, headers=alice.headers)
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


@pytest.fixture
def limited_client(fake_vision: list[Any]) -> Iterator[tuple[TestClient, FastAPI]]:
    from sudoku_api.main import create_app
    from sudoku_api.models import Base
    from sudoku_api.services.email import ConsoleEmailSender

    app = create_app(
        make_settings(rate_limit_enabled=True, import_rate_limit="2/minute"),
        email_sender=ConsoleEmailSender(),
    )
    Base.metadata.create_all(app.state.engine)
    with TestClient(app, base_url="https://testserver") as c:
        yield c, app
    app.state.engine.dispose()


def test_recognize_rate_limited_before_reading_body(
    limited_client: tuple[TestClient, FastAPI],
) -> None:
    client, app = limited_client
    sender = app.state.email_sender
    from tests.conftest import make_account

    acc = make_account(client, sender.outbox, "carol")
    codes = [_upload(client, acc).status_code for _ in range(3)]
    assert codes == [200, 200, 429]
    assert _upload(client, None).status_code == 429  # throttled even before auth


def test_generated_candidate_never_reuses_an_imported_row(
    app: FastAPI, alice: Account, client: TestClient
) -> None:
    """If the generator happens to produce givens a player imported, that row is not served
    as a generated (ranked) game, and it is never pooled."""
    from sudoku_api.errors import ApiError
    from sudoku_api.models import User
    from sudoku_api.services import games as game_service
    from sudoku_api.services.pool import AddResult, add_to_pool
    from sudoku_api.services.puzzle_source import SourcePuzzle

    assert _import(client, alice, HARD_GIVENS).status_code == 201
    candidate = SourcePuzzle(HARD_GIVENS, HARD_SOLUTION, Difficulty.hard, 0, {}, None)
    with app.state.session_factory() as s:
        user = s.scalar(select(User).where(User.username == "alice"))
        assert user is not None
        assert add_to_pool(s, candidate, "test") is AddResult.duplicate
        s.rollback()
        with pytest.raises(ApiError) as exc:
            game_service.create_game(s, user, Difficulty.hard, candidate=candidate)
        assert exc.value.status_code == 503
        assert s.scalar(select(func.count()).select_from(PuzzlePool)) == 0


@pytest.mark.parametrize(
    "corners",
    [
        [[1, 1], [1, 1], [1, 1], [1, 1]],  # zero area
        [[0, 0], [10, 0], [20, 0], [30, 0]],  # collinear
    ],
)
def test_degenerate_corners_are_validation_errors(
    client: TestClient, alice: Account, corners: list[list[int]]
) -> None:
    """The real `recognize` raises ValueError for these corners; that is the client's fault."""
    image = (VISION_FIXTURES / "synth_7_00.jpg").read_bytes()
    r = _upload(client, alice, image=image, corners=json.dumps(corners))
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_error"


def test_value_error_without_corners_is_unavailable(
    client: TestClient, alice: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(image: bytes, corners: Any) -> Recognition:
        raise ValueError("internal bug")

    monkeypatch.setattr(recognition, "vision_recognize", broken)
    r = _upload(client, alice)
    assert r.status_code == 503
    assert r.json()["code"] == "recognition_unavailable"


def test_real_recognition_end_to_end(client: TestClient, alice: Account) -> None:
    """Real `sudoku_vision.recognize` (no monkeypatching) on a committed vision fixture,
    read-only, then the reviewed board is imported as a game."""
    labels = json.loads((VISION_FIXTURES / "synth_7_00.json").read_text())
    image = (VISION_FIXTURES / "synth_7_00.jpg").read_bytes()
    r = client.post(
        f"{API}/imports/recognize",
        files={"file": ("synth_7_00.jpg", image, "image/jpeg")},
        headers=alice.headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["image_size"]["width"] > 0
    assert len(body["corners"]) == 4

    expected: list[tuple[int, str]] = []
    for g, h in zip(labels["givens"], labels["handwritten"], strict=True):
        if g != ".":
            expected.append((int(g), "given"))
        elif h != ".":
            expected.append((int(h), "handwritten"))
        else:
            expected.append((0, "empty"))
    actual = [(c["digit"], c["kind"]) for c in body["cells"]]
    assert actual == expected
    for c in body["cells"]:
        assert (c["alternatives"] == []) == (c["kind"] == "empty"), c

    givens = "".join(str(c["digit"]) if c["kind"] == "given" else "0" for c in body["cells"])
    current = "".join(str(c["digit"]) for c in body["cells"])
    imported = _import(client, alice, givens, current)
    assert imported.status_code == 201, imported.text
    game = imported.json()
    assert game["source"] == "imported"
    assert game["givens"] == givens
    assert game["current"] == current
