"""Search mode (PLAN.md §5.5): SearchTree validation, PATCH persistence, propagate, scoring."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sudoku_api.schemas.search import MAX_NODES, MAX_TREE_BYTES, SearchTree
from sudoku_api.services.scoring import AUTO_PLACEMENT_PENALTY

from tests.conftest import API, Account, make_account, make_settings, solution_of
from tests.test_games import first_empty, new_game, with_cell

GIVENS = "530070000600195000098000060800060003400803001700020006060000280000419005000080079"


def node(
    node_id: str,
    parent_id: str | None,
    choice: dict[str, int] | None = None,
    placements: list[dict[str, Any]] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "parent_id": parent_id,
        "choice": choice,
        "placements": placements or [],
        "status": "open",
        "contradiction": None,
        "branch_cell": None,
        "collapsed": False,
        **extra,
    }


def make_tree(root_board: str, nodes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """A root plus two alternative children for the first empty cell of `root_board`."""
    empties = [i for i, c in enumerate(root_board) if c == "0"]
    cell, other = empties[0], empties[1]
    if nodes is None:
        nodes = [
            node("root", None, branch_cell=cell),
            node(
                "a",
                "root",
                {"cell": cell, "value": 1},
                [{"cell": other, "value": 2, "source": "manual"}],
            ),
            node(
                "b",
                "root",
                {"cell": cell, "value": 2},
                status="dead",
                contradiction={
                    "kind": "duplicate",
                    "cells": [0, 1],
                    "digit": 2,
                    "unit": "row 1",
                    "explanation": "2 appears twice in row 1 (r1c1, r1c2).",
                },
            ),
        ]
    return {
        "version": 1,
        "root_board": root_board,
        "mode": "manual",
        "selected_node_id": "a",
        "nodes": nodes,
    }


def invalid(tree: dict[str, Any]) -> str:
    with pytest.raises(ValidationError) as exc:
        SearchTree.model_validate(tree)
    return str(exc.value)


# --- SearchTree validation (no HTTP) -------------------------------------------------------


def test_valid_tree() -> None:
    tree = make_tree(GIVENS)
    parsed = SearchTree.model_validate(tree)
    assert parsed.model_dump() == tree


def test_version_must_be_1() -> None:
    assert "version" in invalid({**make_tree(GIVENS), "version": 2})


def test_root_board_regex() -> None:
    for bad in ["1" * 80, "x" * 81, GIVENS.replace("0", ".")]:
        assert "root_board" in invalid({**make_tree(GIVENS), "root_board": bad})


def test_unknown_fields_rejected() -> None:
    assert "extra" in invalid({**make_tree(GIVENS), "solution": "1" * 81}).lower()


def test_too_many_nodes() -> None:
    nodes = [node("root", None)] + [
        node(f"n{i}", "root", {"cell": 2, "value": 1}) for i in range(MAX_NODES)
    ]
    assert "nodes" in invalid({**make_tree(GIVENS, nodes), "selected_node_id": "root"})


def test_max_nodes_accepted() -> None:
    nodes = [node("root", None)] + [
        node(f"n{i}", "root", {"cell": 2, "value": 1}) for i in range(MAX_NODES - 1)
    ]
    SearchTree.model_validate({**make_tree(GIVENS, nodes), "selected_node_id": "root"})


def test_duplicate_ids() -> None:
    tree = make_tree(GIVENS)
    tree["nodes"][2]["id"] = "a"
    assert "duplicate node id" in invalid(tree)


def test_id_length() -> None:
    tree = make_tree(GIVENS)
    long_id = "x" * 37
    tree["nodes"][1]["id"] = long_id
    tree["selected_node_id"] = long_id
    assert "36" in invalid(tree)
    tree["nodes"][1]["id"] = tree["selected_node_id"] = "x" * 36  # a UUID fits
    SearchTree.model_validate(tree)
    tree["nodes"][1]["id"] = tree["selected_node_id"] = ""
    invalid(tree)


def test_two_roots() -> None:
    tree = make_tree(GIVENS)
    tree["nodes"].append(node("root2", None))
    assert "exactly one root, found 2" in invalid(tree)


def test_no_root() -> None:
    tree = make_tree(GIVENS)
    tree["nodes"][0]["parent_id"] = "a"
    assert "exactly one root, found 0" in invalid(tree)


def test_root_has_no_choice_or_placements() -> None:
    tree = make_tree(GIVENS)
    tree["nodes"][0]["choice"] = {"cell": 2, "value": 1}
    assert "root node" in invalid(tree)
    tree = make_tree(GIVENS)
    tree["nodes"][0]["placements"] = [{"cell": 2, "value": 1, "source": "manual"}]
    assert "root node" in invalid(tree)


def test_non_root_needs_choice() -> None:
    tree = make_tree(GIVENS)
    tree["nodes"][1]["choice"] = None
    assert "must have a choice" in invalid(tree)


def test_unknown_parent() -> None:
    tree = make_tree(GIVENS)
    tree["nodes"][2]["parent_id"] = "nope"
    assert "unknown parent_id" in invalid(tree)


def test_cycle() -> None:
    tree = make_tree(GIVENS)
    tree["nodes"] += [
        node("c1", "c2", {"cell": 2, "value": 3}),
        node("c2", "c1", {"cell": 2, "value": 4}),
    ]
    assert "cycle" in invalid(tree)


def test_self_parent_cycle() -> None:
    tree = make_tree(GIVENS)
    tree["nodes"].append(node("self", "self", {"cell": 2, "value": 3}))
    assert "cycle" in invalid(tree)


def test_selected_node_must_exist() -> None:
    assert "selected_node_id" in invalid({**make_tree(GIVENS), "selected_node_id": "zzz"})


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("nodes", 1, "choice", "cell"), 81),
        (("nodes", 1, "choice", "cell"), -1),
        (("nodes", 1, "choice", "value"), 0),
        (("nodes", 1, "choice", "value"), 10),
        (("nodes", 1, "placements", 0, "cell"), 81),
        (("nodes", 1, "placements", 0, "value"), 0),
        (("nodes", 1, "placements", 0, "source"), "solver"),
        (("nodes", 0, "branch_cell"), 81),
        (("nodes", 2, "contradiction", "cells", 0), 99),
        (("nodes", 2, "contradiction", "digit"), 10),
        (("nodes", 2, "contradiction", "kind"), "wrong_value"),
        (("nodes", 2, "status"), "won"),
        (("mode",), "turbo"),
    ],
)
def test_field_ranges(path: tuple[Any, ...], value: Any) -> None:
    tree = make_tree(GIVENS)
    target: Any = tree
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    invalid(tree)


def big_tree(root_board: str, n_nodes: int = 400) -> dict[str, Any]:
    """A chain of nodes with 81 placements each: well-formed, but far over 256 KB."""
    placements = [{"cell": c, "value": 1 + c % 9, "source": "auto"} for c in range(81)]
    nodes = [node("root", None)] + [
        node(f"n{i}", "root" if i == 0 else f"n{i - 1}", {"cell": 2, "value": 1}, placements)
        for i in range(n_nodes)
    ]
    return {**make_tree(root_board, nodes), "selected_node_id": "root"}


def test_too_large() -> None:
    tree = big_tree(GIVENS)
    assert len(json.dumps(tree)) > MAX_TREE_BYTES
    assert "limit is 262144" in invalid(tree)


# --- PATCH /games/{id} ------------------------------------------------------------------------


def save(client: TestClient, acc: Account, g: dict[str, Any], version: int, **extra: Any) -> Any:
    body = {"current": g["current"], "notes": {}, "elapsed_seconds": 1, "version": version}
    return client.patch(f"{API}/games/{g['id']}", json={**body, **extra}, headers=acc.headers)


def test_new_game_has_no_tree(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    assert g["search_tree"] is None
    assert g["auto_placements"] == 0
    assert g["search_costs"] == {"auto_placement": AUTO_PLACEMENT_PENALTY}


def test_patch_search_tree_round_trip_and_clear(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    tree = make_tree(g["current"])

    r = save(client, alice, g, 1, search_tree=tree)
    assert r.status_code == 200, r.text
    assert r.json()["search_tree"] == tree
    assert r.json()["version"] == 2  # saving the tree is an autosave
    assert client.get(f"{API}/games/{g['id']}", headers=alice.headers).json()["search_tree"] == tree

    # Omitted: unchanged.
    r = save(client, alice, g, 2)
    assert r.status_code == 200
    assert r.json()["search_tree"] == tree
    assert r.json()["version"] == 3

    # Replaced.
    tree2 = copy.deepcopy(tree)
    tree2["mode"] = "auto"
    tree2["selected_node_id"] = "b"
    assert save(client, alice, g, 3, search_tree=tree2).json()["search_tree"] == tree2

    # Explicit null: cleared.
    r = save(client, alice, g, 4, search_tree=None)
    assert r.status_code == 200
    assert r.json()["search_tree"] is None
    assert r.json()["version"] == 5
    assert client.get(f"{API}/games/{g['id']}", headers=alice.headers).json()["search_tree"] is None


def test_patch_search_tree_root_board_keeps_givens(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    given = next(i for i, c in enumerate(g["givens"]) if c != "0")
    other = "1" if g["givens"][given] != "1" else "2"
    for board in (with_cell(g["givens"], given, other), with_cell(g["givens"], given, "0")):
        r = save(client, alice, g, 1, search_tree=make_tree(board))
        assert r.status_code == 422
        assert r.json()["code"] == "givens_modified"
    after = client.get(f"{API}/games/{g['id']}", headers=alice.headers).json()
    assert after["version"] == 1
    assert after["search_tree"] is None


def test_patch_search_tree_may_differ_from_current(client: TestClient, alice: Account) -> None:
    """The root is a snapshot: it may hold digits that are no longer on the main board."""
    g = new_game(client, alice)
    i = first_empty(g["givens"])
    r = save(client, alice, g, 1, search_tree=make_tree(with_cell(g["givens"], i, "9")))
    assert r.status_code == 200, r.text


def test_patch_invalid_search_tree(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    tree = make_tree(g["current"])
    tree["nodes"].append(node("root2", None))
    r = save(client, alice, g, 1, search_tree=tree)
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"
    assert "exactly one root" in r.json()["detail"]


def test_patch_search_tree_too_large(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    r = save(client, alice, g, 1, search_tree=big_tree(g["current"]))
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


def test_complete_accepts_search_tree(client: TestClient, alice: Account, app: FastAPI) -> None:
    g = new_game(client, alice)
    sol = solution_of(app, g["id"])
    tree = make_tree(g["current"])
    r = client.post(
        f"{API}/games/{g['id']}/complete",
        json={"current": sol, "elapsed_seconds": 5, "version": 1, "search_tree": tree},
        headers=alice.headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["search_tree"] == tree


# --- POST /games/{id}/search/propagate ----------------------------------------------------


def propagate(client: TestClient, acc: Account, gid: int, board: str) -> Any:
    return client.post(
        f"{API}/games/{gid}/search/propagate", json={"board": board}, headers=acc.headers
    )


def test_propagate_placements_and_costs(client: TestClient, alice: Account, app: FastAPI) -> None:
    g = new_game(client, alice, "medium")
    sol = solution_of(app, g["id"])
    r = propagate(client, alice, g["id"], g["current"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"placements", "contradiction", "penalty", "auto_placements"}
    n = len(body["placements"])
    assert 0 < n < g["current"].count("0")
    seen: set[int] = set()
    for p in body["placements"]:
        assert set(p) == {"cell", "value", "technique"}
        assert p["technique"] in {"Naked Single", "Hidden Single"}
        assert g["current"][p["cell"]] == "0"
        assert p["cell"] not in seen
        seen.add(p["cell"])
        assert str(p["value"]) == sol[p["cell"]]  # singles on a valid board are forced
    assert body["contradiction"] is None
    assert body["penalty"] == n * AUTO_PLACEMENT_PENALTY
    assert body["auto_placements"] == n

    # Costs accumulate.
    again = propagate(client, alice, g["id"], g["current"]).json()
    assert again["auto_placements"] == 2 * n
    assert again["penalty"] == n * AUTO_PLACEMENT_PENALTY

    state = client.get(f"{API}/games/{g['id']}", headers=alice.headers).json()
    assert state["auto_placements"] == 2 * n
    # Like hints: no version bump, so an autosave with the old version still succeeds.
    assert state["version"] == 1
    assert save(client, alice, g, 1).status_code == 200


def test_propagate_nothing_to_do_is_free(client: TestClient, alice: Account, app: FastAPI) -> None:
    g = new_game(client, alice, "medium")
    sol = solution_of(app, g["id"])
    body = propagate(client, alice, g["id"], sol).json()
    assert body == {"placements": [], "contradiction": None, "penalty": 0, "auto_placements": 0}


def test_propagate_contradiction(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice, "medium")
    board = g["current"]
    # Put a row's given digit into an empty cell of the same row: a duplicate.
    cell = next(
        i
        for i, c in enumerate(board)
        if c == "0" and any(board[(i // 9) * 9 + k] != "0" for k in range(9))
    )
    row = cell // 9
    digit = next(board[row * 9 + k] for k in range(9) if board[row * 9 + k] != "0")
    r = propagate(client, alice, g["id"], with_cell(board, cell, digit))
    assert r.status_code == 200
    body = r.json()
    assert body["placements"] == []
    assert body["penalty"] == 0
    assert body["auto_placements"] == 0
    c = body["contradiction"]
    assert set(c) == {"kind", "cells", "digit", "unit", "explanation"}
    assert c["kind"] == "duplicate"
    assert c["digit"] == int(digit)
    assert cell in c["cells"]
    assert c["unit"] is not None
    assert c["explanation"]


def test_propagate_never_leaks_solution(client: TestClient, alice: Account, app: FastAPI) -> None:
    for difficulty in ("medium", "hard", "expert", "master", "extreme"):
        g = new_game(client, alice, difficulty)
        solution = solution_of(app, g["id"])
        r = propagate(client, alice, g["id"], g["current"])
        assert r.status_code == 200
        placed = len(r.json()["placements"])
        assert placed < g["current"].count("0"), "propagation must stay incomplete here"
        assert solution not in r.text
        tree = make_tree(g["current"])
        saved = save(client, alice, g, 1, search_tree=tree)
        assert solution not in saved.text
        state = client.get(f"{API}/games/{g['id']}", headers=alice.headers)
        assert solution not in state.text
        assert "solution" not in state.json()


def test_propagate_ownership_404(client: TestClient, alice: Account, bob: Account) -> None:
    g = new_game(client, alice, "medium")
    for gid in (g["id"], 999_999):
        r = propagate(client, bob, gid, g["current"])
        assert r.status_code == 404
        assert r.json()["code"] == "not_found"
    assert (
        client.get(f"{API}/games/{g['id']}", headers=alice.headers).json()["auto_placements"] == 0
    )


def test_propagate_requires_auth(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice)
    r = client.post(f"{API}/games/{g['id']}/search/propagate", json={"board": g["current"]})
    assert r.status_code == 401


def test_propagate_not_in_progress(client: TestClient, alice: Account) -> None:
    old = new_game(client, alice, "medium")
    new_game(client, alice, "medium")  # abandons `old`
    r = propagate(client, alice, old["id"], old["current"])
    assert r.status_code == 409
    assert r.json()["code"] == "game_not_in_progress"


def test_propagate_givens_modified(client: TestClient, alice: Account) -> None:
    g = new_game(client, alice, "medium")
    given = next(i for i, c in enumerate(g["givens"]) if c != "0")
    r = propagate(client, alice, g["id"], with_cell(g["givens"], given, "0"))
    assert r.status_code == 422
    assert r.json()["code"] == "givens_modified"


@pytest.mark.parametrize("board", ["1" * 80, "x" * 81, "." * 81, None])
def test_propagate_board_validation(client: TestClient, alice: Account, board: Any) -> None:
    g = new_game(client, alice)
    r = propagate(client, alice, g["id"], board)
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


def test_propagate_rate_limited() -> None:
    from sudoku_api.main import create_app
    from sudoku_api.models import Base
    from sudoku_api.services.email import ConsoleEmailSender

    sender = ConsoleEmailSender()
    app = create_app(
        make_settings(
            rate_limit_enabled=True, search_rate_limit="2/minute", auth_rate_limit="100/minute"
        ),
        email_sender=sender,
    )
    Base.metadata.create_all(app.state.engine)
    with TestClient(app, base_url="https://testserver") as client:
        acc = make_account(client, sender.outbox, "carol")
        g = new_game(client, acc, "medium")
        codes = [propagate(client, acc, g["id"], g["current"]) for _ in range(3)]
        assert [r.status_code for r in codes] == [200, 200, 429]
        assert codes[-1].json()["code"] == "rate_limited"
        # Its own bucket: hints are still available.
        hint = client.post(f"{API}/games/{g['id']}/hint", json={"stage": 1}, headers=acc.headers)
        assert hint.status_code == 200


# --- Scoring ------------------------------------------------------------------------------


def test_complete_subtracts_search_penalty(
    client: TestClient, alice: Account, app: FastAPI
) -> None:
    g = new_game(client, alice, "medium")
    sol = solution_of(app, g["id"])
    n = len(propagate(client, alice, g["id"], g["current"]).json()["placements"])
    # Manual search is free: saving a tree costs nothing.
    assert save(client, alice, g, 1, search_tree=make_tree(g["current"])).status_code == 200
    r = client.post(
        f"{API}/games/{g['id']}/complete",
        json={"current": sol, "elapsed_seconds": 60, "version": 2, "auto_placements": 0},
        headers=alice.headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    breakdown = body["score_breakdown"]
    assert breakdown["search_penalty"] == n * AUTO_PLACEMENT_PENALTY
    assert body["score"] == breakdown["total"] == 375 - n * AUTO_PLACEMENT_PENALTY
    assert body["auto_placements"] == n
