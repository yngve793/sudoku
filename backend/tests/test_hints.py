from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sudoku_api.services.scoring import hint_cost

from tests.conftest import API, Account, make_account, make_settings, solution_of
from tests.test_games import first_empty, new_game, with_cell

HINT_FIELDS = {"kind", "stage", "technique", "cells", "value", "explanation", "penalty"}


def test_staged_step_hint(client: TestClient, alice: Account, app: FastAPI) -> None:
    g = new_game(client, alice)
    gid, h = g["id"], alice.headers
    sol = solution_of(app, gid)

    s1 = client.post(f"{API}/games/{gid}/hint", json={"stage": 1}, headers=h).json()
    s2 = client.post(f"{API}/games/{gid}/hint", json={"stage": 2}, headers=h).json()
    s3 = client.post(f"{API}/games/{gid}/hint", json={"stage": 3}, headers=h).json()
    assert set(s1) == set(s2) == set(s3) == HINT_FIELDS
    assert s1["kind"] == s2["kind"] == s3["kind"] == "step"
    assert [s["stage"] for s in (s1, s2, s3)] == [1, 2, 3]
    assert s1["technique"] == s2["technique"] == s3["technique"]
    assert s1["technique"]  # the validator names the technique (e.g. "Naked Single")

    target = s3["cells"][0]
    assert s3["value"] == int(sol[target])
    assert g["current"][target] == "0"
    # Stage 1: a whole row/column/box containing the target, no value.
    assert len(s1["cells"]) == 9
    assert target in s1["cells"]
    assert s1["value"] is None
    # Stage 2: exact pattern cells (target first), still no value in any field.
    assert s2["cells"] == s3["cells"]
    assert s2["value"] is None
    assert f"= {s3['value']}" not in s2["explanation"]
    assert s3["penalty"] > s2["penalty"] > s1["penalty"]
    assert s1["penalty"] == hint_cost(1)

    assert client.get(f"{API}/games/{gid}", headers=h).json()["hints_used"] == 3


def test_hint_does_not_bump_version(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    client.post(f"{API}/games/{g['id']}/hint", json={"stage": 1}, headers=alice.headers)
    assert client.get(f"{API}/games/{g['id']}", headers=alice.headers).json()["version"] == 1


def test_error_hint_first(client: TestClient, alice: Account, app: FastAPI) -> None:
    g = new_game(client, alice)
    gid, h = g["id"], alice.headers
    sol = solution_of(app, gid)
    i = first_empty(g["current"])
    bad = with_cell(g["current"], i, "1" if sol[i] != "1" else "2")
    s1 = client.post(f"{API}/games/{gid}/hint", json={"stage": 1, "current": bad}, headers=h).json()
    assert s1["kind"] == "error"
    assert s1["cells"] == []
    s2 = client.post(f"{API}/games/{gid}/hint", json={"stage": 2, "current": bad}, headers=h).json()
    assert s2["kind"] == "error"
    assert s2["cells"] == [i]
    assert s2["value"] is None
    assert "incorrect" in s2["explanation"]


def test_hint_stage_validation(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    for bad in [0, 4, "x"]:
        r = client.post(f"{API}/games/{g['id']}/hint", json={"stage": bad}, headers=alice.headers)
        assert r.status_code == 422


def test_hint_on_solved_board(client: TestClient, alice: Account, app: FastAPI) -> None:
    g = new_game(client, alice)
    sol = solution_of(app, g["id"])
    r = client.post(
        f"{API}/games/{g['id']}/hint", json={"stage": 1, "current": sol}, headers=alice.headers
    )
    assert r.status_code == 409
    assert r.json()["code"] == "no_hint_available"


def test_hint_rate_limited() -> None:
    from sudoku_api.main import create_app
    from sudoku_api.models import Base
    from sudoku_api.services.email import ConsoleEmailSender

    sender = ConsoleEmailSender()
    app = create_app(
        make_settings(
            rate_limit_enabled=True, hint_rate_limit="2/minute", auth_rate_limit="100/minute"
        ),
        email_sender=sender,
    )
    Base.metadata.create_all(app.state.engine)
    with TestClient(app, base_url="https://testserver") as client:
        acc = make_account(client, sender.outbox, "carol")
        g = new_game(client, acc)
        codes = [
            client.post(f"{API}/games/{g['id']}/hint", json={"stage": 1}, headers=acc.headers)
            for _ in range(3)
        ]
        assert [r.status_code for r in codes] == [200, 200, 429]
        assert codes[-1].json() == {
            "detail": "Too many requests, please slow down",
            "code": "rate_limited",
        }
