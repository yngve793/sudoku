from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.conftest import API, Account, solution_of

GAME_FIELDS = {
    "id",
    "difficulty",
    "status",
    "givens",
    "current",
    "notes",
    "elapsed_seconds",
    "hints_used",
    "mistakes",
    "score",
    "version",
    "started_at",
    "updated_at",
    "completed_at",
    "hint_costs",
}


def new_game(client: TestClient, acc: Account, difficulty: str = "easy") -> dict[str, Any]:
    r = client.post(f"{API}/games", json={"difficulty": difficulty}, headers=acc.headers)
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


def first_empty(grid: str) -> int:
    return grid.index("0")


def with_cell(grid: str, i: int, d: str) -> str:
    return grid[:i] + d + grid[i + 1 :]


@pytest.mark.parametrize(
    "difficulty", ["beginner", "easy", "medium", "hard", "expert", "master", "extreme"]
)
def test_create_game_every_difficulty(client: TestClient, alice: Account, difficulty: str) -> None:
    g = new_game(client, alice, difficulty)
    assert set(g) == GAME_FIELDS
    assert g["difficulty"] == difficulty
    assert g["status"] == "in_progress"
    assert g["current"] == g["givens"]
    assert len(g["givens"]) == 81
    assert g["hint_costs"] == {"1": 10, "2": 20, "3": 40}
    assert g["notes"] == {}
    assert g["version"] == 1
    assert g["score"] is None


def test_solution_never_in_in_progress_responses(
    client: TestClient, alice: Account, app: FastAPI
) -> None:
    """Every endpoint touching an in-progress game must not leak the solution."""
    g = new_game(client, alice)
    solution = solution_of(app, g["id"])
    h = alice.headers
    gid = g["id"]
    i = first_empty(g["current"])
    responses = [
        client.get(f"{API}/games/{gid}", headers=h),
        client.get(f"{API}/games/current", headers=h),
        client.patch(
            f"{API}/games/{gid}",
            json={
                "current": with_cell(g["current"], i, solution[i]),
                "notes": {},
                "elapsed_seconds": 5,
                "version": 1,
            },
            headers=h,
        ),
        client.post(f"{API}/games/{gid}/check", headers=h),
        client.post(f"{API}/games/{gid}/hint", json={"stage": 1}, headers=h),
        client.post(f"{API}/games/{gid}/hint", json={"stage": 2}, headers=h),
        client.post(f"{API}/games/{gid}/complete", headers=h),  # not solved yet -> 422
        client.get(f"{API}/scores/me", headers=h),
        client.get(f"{API}/me", headers=h),
    ]
    for r in responses:
        assert "solution" not in r.json() if isinstance(r.json(), dict) else True
        assert solution not in r.text, r.request.url
    assert "solution" not in client.get(f"{API}/games/{gid}", headers=h).json()
    # Also absent from the schema itself.
    schema = app.openapi()["components"]["schemas"]["GameOut"]["properties"]
    assert "solution" not in schema


def test_get_current_and_by_id(client: TestClient, alice: Account) -> None:
    r = client.get(f"{API}/games/current", headers=alice.headers)
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"
    g = new_game(client, alice)
    assert client.get(f"{API}/games/current", headers=alice.headers).json()["id"] == g["id"]
    assert client.get(f"{API}/games/{g['id']}", headers=alice.headers).json()["id"] == g["id"]


def test_new_game_abandons_current(client: TestClient, alice: Account) -> None:
    g1 = new_game(client, alice)
    g2 = new_game(client, alice, "hard")
    assert (
        client.get(f"{API}/games/{g1['id']}", headers=alice.headers).json()["status"] == "abandoned"
    )
    assert client.get(f"{API}/games/current", headers=alice.headers).json()["id"] == g2["id"]


def test_other_users_games_are_404(client: TestClient, alice: Account, bob: Account) -> None:
    g = new_game(client, alice)
    gid = g["id"]
    payload = {"current": g["current"], "notes": {}, "elapsed_seconds": 1, "version": 1}
    calls = [
        client.get(f"{API}/games/{gid}", headers=bob.headers),
        client.patch(f"{API}/games/{gid}", json=payload, headers=bob.headers),
        client.post(f"{API}/games/{gid}/hint", json={"stage": 1}, headers=bob.headers),
        client.post(f"{API}/games/{gid}/check", headers=bob.headers),
        client.post(f"{API}/games/{gid}/complete", headers=bob.headers),
    ]
    missing = client.get(f"{API}/games/999999", headers=bob.headers)
    for r in calls:
        assert r.status_code == 404, r.text
        assert r.json() == missing.json() == {"detail": "Game not found", "code": "not_found"}


def test_games_require_auth(client: TestClient) -> None:
    assert client.post(f"{API}/games", json={"difficulty": "easy"}).status_code == 401
    assert client.get(f"{API}/games/current").status_code == 401


def test_autosave_round_trip_and_version(client: TestClient, alice: Account, app: FastAPI) -> None:
    g = new_game(client, alice)
    sol = solution_of(app, g["id"])
    i = first_empty(g["current"])
    board = with_cell(g["current"], i, sol[i])
    notes = {"5": [9, 3, 3], "10": [], "80": [1]}
    r = client.patch(
        f"{API}/games/{g['id']}",
        json={"current": board, "notes": notes, "elapsed_seconds": 42, "version": 1},
        headers=alice.headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 2
    assert body["current"] == board
    assert body["notes"] == {"5": [3, 9], "80": [1]}  # normalised: sorted, deduped, empties dropped
    assert body["elapsed_seconds"] == 42
    resumed = client.get(f"{API}/games/current", headers=alice.headers).json()
    assert resumed["current"] == board
    assert resumed["notes"] == body["notes"]
    assert resumed["elapsed_seconds"] == 42


def test_version_conflict(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    payload = {"current": g["current"], "notes": {}, "elapsed_seconds": 1, "version": 1}
    assert (
        client.patch(f"{API}/games/{g['id']}", json=payload, headers=alice.headers).status_code
        == 200
    )
    r = client.patch(f"{API}/games/{g['id']}", json=payload, headers=alice.headers)
    assert r.status_code == 409
    assert r.json()["code"] == "version_conflict"


def test_elapsed_time_never_goes_backwards(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    h = alice.headers
    client.patch(
        f"{API}/games/{g['id']}",
        json={"current": g["current"], "elapsed_seconds": 100, "version": 1},
        headers=h,
    )
    r = client.patch(
        f"{API}/games/{g['id']}",
        json={"current": g["current"], "elapsed_seconds": 3, "version": 2},
        headers=h,
    )
    assert r.json()["elapsed_seconds"] == 100


@pytest.mark.parametrize(
    "current",
    ["1" * 80, "1" * 82, "a" * 81, "." * 81, "1" * 80 + "x", ""],
)
def test_grid_regex_validation(client: TestClient, alice: Account, current: str) -> None:
    g = new_game(client, alice)
    r = client.patch(
        f"{API}/games/{g['id']}",
        json={"current": current, "notes": {}, "elapsed_seconds": 1, "version": 1},
        headers=alice.headers,
    )
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


@pytest.mark.parametrize(
    "notes",
    [{"81": [1]}, {"-1": [1]}, {"a": [1]}, {"01": [1]}, {"3": [0]}, {"3": [10]}],
)
def test_notes_validation(client: TestClient, alice: Account, notes: dict[str, Any]) -> None:
    g = new_game(client, alice)
    r = client.patch(
        f"{API}/games/{g['id']}",
        json={"current": g["current"], "notes": notes, "elapsed_seconds": 1, "version": 1},
        headers=alice.headers,
    )
    assert r.status_code == 422


def test_givens_cannot_change(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    givens = g["givens"]
    i = next(k for k, ch in enumerate(givens) if ch != "0")
    tampered = with_cell(givens, i, "0" if givens[i] != "0" else "1")
    r = client.patch(
        f"{API}/games/{g['id']}",
        json={"current": tampered, "notes": {}, "elapsed_seconds": 1, "version": 1},
        headers=alice.headers,
    )
    assert r.status_code == 422
    assert r.json()["code"] == "givens_modified"


def test_check_counts_mistakes(client: TestClient, alice: Account, app: FastAPI) -> None:
    g = new_game(client, alice)
    sol = solution_of(app, g["id"])
    i = first_empty(g["current"])
    wrong = str((sol[i] == "9" and 1) or int(sol[i]) + 1)
    board = with_cell(g["current"], i, wrong)
    client.patch(
        f"{API}/games/{g['id']}",
        json={"current": board, "elapsed_seconds": 1, "version": 1},
        headers=alice.headers,
    )
    r = client.post(f"{API}/games/{g['id']}/check", headers=alice.headers)
    assert r.status_code == 200
    assert r.json() == {"wrong_cells": [i], "mistakes": 1}
    # Checking an unsaved board supplied in the body.
    r = client.post(
        f"{API}/games/{g['id']}/check", json={"current": g["givens"]}, headers=alice.headers
    )
    assert r.json() == {"wrong_cells": [], "mistakes": 1}


def test_complete_requires_solved_board(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    r = client.post(f"{API}/games/{g['id']}/complete", headers=alice.headers)
    assert r.status_code == 422
    assert r.json()["code"] == "board_not_solved"
    assert (
        client.get(f"{API}/games/{g['id']}", headers=alice.headers).json()["status"]
        == "in_progress"
    )


def test_complete_computes_score_server_side(
    client: TestClient, alice: Account, app: FastAPI
) -> None:
    g = new_game(client, alice, "medium")
    sol = solution_of(app, g["id"])
    r = client.post(
        f"{API}/games/{g['id']}/complete",
        json={
            "current": sol,
            "notes": {},
            "elapsed_seconds": 60,
            "version": 1,
            "score": 999_999,  # ignored
            "hints_used": 0,
        },
        headers=alice.headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "completed"
    assert body["score"] == 375  # 250 base x 1.5 (under par), no penalties
    assert body["score_breakdown"]["total"] == 375
    assert body["completed_at"] is not None
    # Cannot complete or edit twice.
    again = client.post(f"{API}/games/{g['id']}/complete", headers=alice.headers)
    assert again.status_code == 409
    assert again.json()["code"] == "game_not_in_progress"
    edit = client.patch(
        f"{API}/games/{g['id']}",
        json={"current": sol, "notes": {}, "elapsed_seconds": 1, "version": body["version"]},
        headers=alice.headers,
    )
    assert edit.status_code == 409
    assert client.get(f"{API}/games/current", headers=alice.headers).status_code == 404


def test_complete_with_stale_version_conflicts(
    client: TestClient, alice: Account, app: FastAPI
) -> None:
    g = new_game(client, alice)
    sol = solution_of(app, g["id"])
    r = client.post(
        f"{API}/games/{g['id']}/complete",
        json={"current": sol, "elapsed_seconds": 1, "version": 7},
        headers=alice.headers,
    )
    assert r.status_code == 409
    assert r.json()["code"] == "version_conflict"


def test_score_reflects_hints_and_mistakes(
    client: TestClient, alice: Account, app: FastAPI
) -> None:
    g = new_game(client, alice, "hard")
    gid, h = g["id"], alice.headers
    sol = solution_of(app, gid)
    i = first_empty(g["current"])
    bad = with_cell(g["current"], i, "1" if sol[i] != "1" else "2")
    client.post(f"{API}/games/{gid}/check", json={"current": bad}, headers=h)  # 1 mistake
    client.post(f"{API}/games/{gid}/hint", json={"stage": 1}, headers=h)
    client.post(f"{API}/games/{gid}/hint", json={"stage": 3}, headers=h)
    r = client.post(
        f"{API}/games/{gid}/complete",
        json={"current": sol, "elapsed_seconds": 10, "version": 1},
        headers=h,
    )
    body = r.json()
    # 500 x 1.5 = 750; hints 10x1 + 10x4 = 50; mistakes 15x1
    assert body["score"] == 750 - 50 - 15
    assert body["hints_used"] == 2
    assert body["mistakes"] == 1


def test_unknown_difficulty(client: TestClient, alice: Account) -> None:
    r = client.post(f"{API}/games", json={"difficulty": "impossible"}, headers=alice.headers)
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"
