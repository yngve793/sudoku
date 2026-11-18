from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import update
from sudoku_api.models import Game, User, utcnow

from tests.conftest import API, Account, make_account, register, solution_of
from tests.test_games import new_game


def finish(
    client: TestClient, app: FastAPI, acc: Account, difficulty: str = "easy", elapsed: int = 10
) -> dict[str, Any]:
    g = new_game(client, acc, difficulty)
    r = client.post(
        f"{API}/games/{g['id']}/complete",
        json={"current": solution_of(app, g["id"]), "elapsed_seconds": elapsed, "version": 1},
        headers=acc.headers,
    )
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def test_leaderboard_is_public_and_hides_email(
    client: TestClient, app: FastAPI, alice: Account
) -> None:
    finish(client, app, alice)
    r = client.get(f"{API}/leaderboard")  # no Authorization header
    assert r.status_code == 200
    body = r.json()
    assert body["period"] == "all"
    assert body["difficulty"] is None
    assert len(body["entries"]) == 1
    entry = body["entries"][0]
    assert set(entry) == {
        "rank",
        "username",
        "difficulty",
        "score",
        "elapsed_seconds",
        "hints_used",
        "completed_at",
    }
    assert entry["username"] == "alice"
    assert "email" not in r.text
    assert alice.email not in r.text
    assert "@" not in r.text
    props = app.openapi()["components"]["schemas"]["LeaderboardEntry"]["properties"]
    assert "email" not in props


def test_leaderboard_only_verified_users(
    client: TestClient, app: FastAPI, alice: Account, bob: Account
) -> None:
    finish(client, app, alice)
    finish(client, app, bob)
    with app.state.session_factory() as s:  # bob somehow loses verified status
        s.execute(update(User).where(User.username == "bob").values(email_verified_at=None))
        s.commit()
    names = [e["username"] for e in client.get(f"{API}/leaderboard").json()["entries"]]
    assert names == ["alice"]


def test_leaderboard_ordering_and_ties(
    client: TestClient, app: FastAPI, alice: Account, bob: Account, outbox: list[Any]
) -> None:
    carol = make_account(client, outbox, "carol")
    finish(client, app, bob)  # same score as alice, but completed earlier
    finish(client, app, alice)
    finish(client, app, carol, elapsed=8 * 60 * 4)  # slow -> lower score
    entries = client.get(f"{API}/leaderboard").json()["entries"]
    assert [e["username"] for e in entries] == ["bob", "alice", "carol"]
    assert [e["rank"] for e in entries] == [1, 2, 3]
    assert entries[0]["score"] == entries[1]["score"] > entries[2]["score"]


def test_leaderboard_filters(client: TestClient, app: FastAPI, alice: Account) -> None:
    finish(client, app, alice, "easy")
    hard = finish(client, app, alice, "hard")
    r = client.get(f"{API}/leaderboard", params={"difficulty": "hard"}).json()
    assert [e["score"] for e in r["entries"]] == [hard["score"]]
    with app.state.session_factory() as s:
        s.execute(
            update(Game)
            .where(Game.id == hard["id"])
            .values(completed_at=utcnow() - timedelta(days=3))
        )
        s.commit()
    assert (
        client.get(f"{API}/leaderboard", params={"difficulty": "hard", "period": "day"}).json()[
            "entries"
        ]
        == []
    )
    assert len(client.get(f"{API}/leaderboard", params={"period": "week"}).json()["entries"]) == 2
    assert len(client.get(f"{API}/leaderboard", params={"limit": 1}).json()["entries"]) == 1
    assert client.get(f"{API}/leaderboard", params={"limit": 0}).status_code == 422
    assert client.get(f"{API}/leaderboard", params={"period": "year"}).status_code == 422


def test_leaderboard_cache_header(client: TestClient) -> None:
    r = client.get(f"{API}/leaderboard")
    assert r.headers["cache-control"].startswith("public")


def test_leaderboard_me(client: TestClient, app: FastAPI, alice: Account, bob: Account) -> None:
    r = client.get(f"{API}/leaderboard/me", headers=alice.headers).json()
    assert r["rank"] is None
    assert r["entry"] is None
    assert r["total"] == 0
    finish(client, app, bob, "hard")
    finish(client, app, alice, "easy")
    me = client.get(f"{API}/leaderboard/me", headers=alice.headers).json()
    assert me["rank"] == 2
    assert me["total"] == 2
    assert me["entry"]["username"] == "alice"
    easy = client.get(
        f"{API}/leaderboard/me", params={"difficulty": "easy"}, headers=alice.headers
    ).json()
    assert easy["rank"] == 1
    assert easy["total"] == 1
    assert client.get(f"{API}/leaderboard/me").status_code == 401


def test_scores_me(client: TestClient, app: FastAPI, alice: Account) -> None:
    first = finish(client, app, alice, "easy", elapsed=10)
    finish(client, app, alice, "easy", elapsed=8 * 60 * 3)
    new_game(client, alice, "hard")  # in progress
    r = client.get(f"{API}/scores/me", headers=alice.headers).json()
    assert len(r["history"]) == 3
    assert r["history"][0]["status"] == "in_progress"
    assert [b["difficulty"] for b in r["best"]] == ["easy"]
    assert r["best"][0]["game_id"] == first["id"]
    assert r["best"][0]["score"] == first["score"]
    me = client.get(f"{API}/me", headers=alice.headers).json()
    assert me["stats"]["games_started"] == 3
    assert me["stats"]["games_completed"] == 2
    assert me["stats"]["best_scores"] == {"easy": first["score"]}


def test_unverified_registration_not_on_board(client: TestClient) -> None:
    register(client, "dave")
    assert client.get(f"{API}/leaderboard").json()["entries"] == []
