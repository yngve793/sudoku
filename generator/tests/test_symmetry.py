from __future__ import annotations

import random

import pytest
from sudoku_generator import Symmetry, dig, random_full_grid
from sudoku_generator.digger import remove, try_remove
from sudoku_validator import count_solutions


@pytest.mark.parametrize("symmetry", list(Symmetry))
def test_orbits_partition_the_grid(symmetry: Symmetry) -> None:
    orbits = symmetry.orbits()
    cells = [c for orbit in orbits for c in orbit]
    assert sorted(cells) == list(range(81))
    for orbit in orbits:
        assert 1 <= len(orbit) <= 2
        for cell in orbit:
            assert symmetry.partner(symmetry.partner(cell)) == cell
            assert symmetry.partner(cell) in orbit


def test_known_partners() -> None:
    assert Symmetry.ROTATIONAL.partner(0) == 80
    assert Symmetry.ROTATIONAL.partner(40) == 40
    assert Symmetry.HORIZONTAL.partner(0) == 72
    assert Symmetry.VERTICAL.partner(0) == 8
    assert Symmetry.DIAGONAL.partner(1) == 9
    assert Symmetry.NONE.partner(17) == 17
    assert len(Symmetry.ROTATIONAL.orbits()) == 41
    assert len(Symmetry.NONE.orbits()) == 81


@pytest.mark.parametrize("symmetry", list(Symmetry))
def test_dig_is_unique_symmetric_and_minimal(symmetry: Symmetry) -> None:
    rng = random.Random(3)
    solution = random_full_grid(rng)
    puzzle = dig(solution, rng, symmetry)
    assert count_solutions(puzzle, limit=2) == 1
    assert symmetry.is_symmetric(puzzle)
    assert all(p in (0, s) for p, s in zip(puzzle, solution, strict=True))
    # Minimal with respect to orbits: no remaining orbit can be removed.
    for orbit in symmetry.orbits():
        if any(puzzle[i] for i in orbit):
            assert try_remove(puzzle, orbit) is None


def test_try_remove_rejects_noop_and_non_unique() -> None:
    solution = random_full_grid(random.Random(1))
    emptied = remove(solution, (0,))
    assert try_remove(emptied, (0,)) is None  # already empty
    almost_empty = remove(solution, range(70))
    assert try_remove(almost_empty, (75,)) is None  # far from unique


def test_is_symmetric_detects_asymmetry() -> None:
    grid = (0,) * 80 + (5,)
    assert not Symmetry.ROTATIONAL.is_symmetric(grid)
    assert Symmetry.NONE.is_symmetric(grid)
