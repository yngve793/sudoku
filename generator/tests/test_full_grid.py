from __future__ import annotations

import random

from hypothesis import given, settings
from hypothesis import strategies as st
from sudoku_generator import random_full_grid
from sudoku_validator import is_consistent


@settings(max_examples=50, deadline=None)
@given(st.integers(min_value=0, max_value=2**63))
def test_full_grid_is_complete_and_valid(seed: int) -> None:
    grid = random_full_grid(random.Random(seed))
    assert len(grid) == 81
    assert 0 not in grid
    assert is_consistent(grid)


def test_full_grid_is_deterministic() -> None:
    assert random_full_grid(random.Random(42)) == random_full_grid(random.Random(42))


def test_full_grid_varies_with_seed() -> None:
    grids = {random_full_grid(random.Random(s)) for s in range(20)}
    assert len(grids) == 20
