from __future__ import annotations

import pytest
from sudoku_validator import count_solutions, format_grid, is_consistent, parse, solve
from sudoku_validator.grid import (
    BOX_OF,
    BOXES,
    CELL_UNITS,
    PEER_BITS,
    PEERS,
    UNIT_NAMES,
    UNITS,
    cell_name,
    is_complete_solution,
    is_well_formed,
)

from .reference import CLASSIC, MULTI_SOLUTION, TWO_SOLUTIONS

WIKI = CLASSIC["wikipedia"]
WIKI_SOLUTION = "534678912672195348198342567859761423426853791713924856961537284287419635345286179"


# ------------------------------------------------------------------------ grid


def test_tables() -> None:
    assert len(UNITS) == 27
    assert all(len(u) == 9 for u in UNITS)
    assert all(len(p) == 20 for p in PEERS)
    assert BOXES[4] == (30, 31, 32, 39, 40, 41, 48, 49, 50)
    assert BOX_OF[80] == 8
    assert CELL_UNITS[10] == (1, 10, 18)
    assert UNIT_NAMES[0] == "row 1"
    assert UNIT_NAMES[9] == "column 1"
    assert UNIT_NAMES[26] == "box 9"
    assert PEER_BITS[0] == sum(1 << p for p in PEERS[0])
    assert cell_name(0) == "r1c1"
    assert cell_name(80) == "r9c9"
    assert cell_name(13) == "r2c5"


def test_parse_variants() -> None:
    g = parse(WIKI)
    assert len(g) == 81
    assert g[0] == 5
    assert g[2] == 0
    assert parse(WIKI.replace(".", "0")) == g
    assert parse(format_grid(g, pretty=True)) == g
    assert parse("\n".join(WIKI[i : i + 9] for i in range(0, 81, 9))) == g


@pytest.mark.parametrize("bad", ["", "1" * 80, "1" * 82, "x" + "." * 80])
def test_parse_rejects(bad: str) -> None:
    with pytest.raises(ValueError, match=r"cells|character"):
        parse(bad)


def test_format_grid() -> None:
    g = parse(WIKI)
    assert format_grid(g) == WIKI.replace(".", "0")
    assert format_grid(g, empty=".") == WIKI
    pretty = format_grid(g, pretty=True).splitlines()
    assert len(pretty) == 11
    assert pretty[0] == "5 3 0 | 0 7 0 | 0 0 0"
    assert pretty[3] == "------+-------+------"
    with pytest.raises(ValueError, match="81 ints"):
        format_grid((0,) * 80)


def test_is_consistent() -> None:
    assert is_consistent(parse(WIKI))
    assert is_consistent((0,) * 81)
    row_dup = parse("11" + "." * 79)
    col_dup = parse("1" + "." * 8 + "1" + "." * 71)
    box_dup = parse("1" + "." * 9 + "1" + "." * 70)
    assert not is_consistent(row_dup)
    assert not is_consistent(col_dup)
    assert not is_consistent(box_dup)
    assert not is_consistent((0,) * 80)
    assert not is_consistent((10,) + (0,) * 80)


def test_is_well_formed() -> None:
    assert is_well_formed((0,) * 81)
    assert not is_well_formed("0" * 81)
    assert not is_well_formed(None)
    assert not is_well_formed((True,) + (0,) * 80)
    assert not is_well_formed((-1,) + (0,) * 80)
    assert is_complete_solution(parse(WIKI_SOLUTION))
    assert not is_complete_solution(parse(WIKI))


# ---------------------------------------------------------------------- solver


def test_solve_known() -> None:
    assert solve(parse(WIKI)) == parse(WIKI_SOLUTION)


@pytest.mark.parametrize("name", sorted(CLASSIC))
def test_classic_puzzles_unique(name: str) -> None:
    grid = parse(CLASSIC[name])
    assert count_solutions(grid) == 1
    sol = solve(grid)
    assert sol is not None
    assert is_complete_solution(sol)
    assert all(g == 0 or g == s for g, s in zip(grid, sol, strict=True))


def test_count_solutions_limits() -> None:
    assert count_solutions(parse(MULTI_SOLUTION)) == 2
    assert count_solutions(parse(MULTI_SOLUTION), limit=5) == 5
    assert count_solutions(parse(TWO_SOLUTIONS), limit=10) == 2
    assert count_solutions(parse(WIKI), limit=1) == 1
    assert count_solutions(parse(WIKI), limit=0) == 0
    assert count_solutions((0,) * 81) == 2


def test_solved_grid() -> None:
    sol = parse(WIKI_SOLUTION)
    assert solve(sol) == sol
    assert count_solutions(sol) == 1


def test_unsolvable_and_invalid() -> None:
    # Consistent givens but no solution: r1c9 cannot hold anything.
    no_solution = parse("12345678." + "........9" + "." * 63)
    assert is_consistent(no_solution)
    assert solve(no_solution) is None
    assert count_solutions(no_solution) == 0
    dup = parse("11" + "." * 79)
    assert solve(dup) is None
    assert count_solutions(dup) == 0
    bad = (12,) + (0,) * 80
    assert solve(bad) is None
    assert count_solutions(bad) == 0
    with pytest.raises(ValueError, match="81"):
        solve((0,) * 80)
    with pytest.raises(ValueError, match="81"):
        count_solutions((0,) * 80, limit=0)
