from __future__ import annotations

from sudoku_validator import parse
from sudoku_validator.state import ALL, BIT, DIGITS_OF, POPCOUNT, State, iter_bits
from sudoku_validator.step import Step


def test_tables() -> None:
    assert sum(BIT[1:]) == ALL
    assert POPCOUNT[ALL] == 9
    assert DIGITS_OF[BIT[3] | BIT[7]] == (3, 7)
    assert list(iter_bits(0b1011)) == [0, 1, 3]


def test_from_grid_and_apply() -> None:
    state = State.from_grid(parse("12345678." + "." * 72))
    assert state.cands[8] == BIT[9]
    assert state.cands[0] == 0
    after = state.apply(Step("t", [(8, 9)], [(9, 1)], [8], "t"))
    assert after.values[8] == 9
    assert after.cands[8] == 0
    assert not after.cands[17] & BIT[9]  # peer lost 9
    assert not after.cands[9] & BIT[1]
    assert not state.is_broken()


def test_is_broken() -> None:
    empty_cell = State((0,) * 81, (0,) + (ALL,) * 80)
    assert empty_cell.is_broken()
    no_place = State((0,) * 81, tuple(ALL & ~BIT[5] if i < 9 else ALL for i in range(81)))
    assert no_place.is_broken()
    assert not State((0,) * 81, (ALL,) * 81).is_broken()
    assert not State((0,) * 81, (ALL,) * 81).solved
