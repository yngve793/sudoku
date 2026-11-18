"""Clue removal that preserves a unique solution."""

from __future__ import annotations

import random
from collections.abc import Iterable

from sudoku_validator import Grid, count_solutions

from .symmetry import Symmetry


def removal_order(symmetry: Symmetry, rng: random.Random) -> list[tuple[int, ...]]:
    """All cell orbits of *symmetry* in a random order drawn from *rng*."""
    orbits = symmetry.orbits()
    rng.shuffle(orbits)
    return orbits


def remove(grid: Grid, orbit: Iterable[int]) -> Grid:
    """Return *grid* with every cell of *orbit* emptied."""
    cells = list(grid)
    for i in orbit:
        cells[i] = 0
    return tuple(cells)


def try_remove(grid: Grid, orbit: Iterable[int]) -> Grid | None:
    """Remove *orbit* from *grid* if the result still has exactly one solution.

    Returns the new grid, or ``None`` if the removal is a no-op (all cells
    already empty) or would break uniqueness.
    """
    candidate = remove(grid, orbit)
    if candidate == grid or count_solutions(candidate, limit=2) != 1:
        return None
    return candidate


def dig(solution: Grid, rng: random.Random, symmetry: Symmetry = Symmetry.ROTATIONAL) -> Grid:
    """Dig a minimal (with respect to *symmetry* orbits) unique puzzle.

    Visits every orbit once in random order and keeps each removal that leaves
    the puzzle uniquely solvable.
    """
    grid = solution
    for orbit in removal_order(symmetry, rng):
        nxt = try_remove(grid, orbit)
        if nxt is not None:
            grid = nxt
    return grid
