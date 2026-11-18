"""Deterministic random puzzles for tests and benchmarks.

Test-only helper: a tiny independent digger so the validator tests never depend
on the generator package.
"""

from __future__ import annotations

import random

from sudoku_validator import Grid, count_solutions
from sudoku_validator.grid import PEERS


def random_solution(rng: random.Random) -> Grid:
    cells = [0] * 81

    def fill(i: int) -> bool:
        if i == 81:
            return True
        used = {cells[p] for p in PEERS[i]}
        digits = [d for d in range(1, 10) if d not in used]
        rng.shuffle(digits)
        for d in digits:
            cells[i] = d
            if fill(i + 1):
                return True
        cells[i] = 0
        return False

    fill(0)
    return tuple(cells)


def dig(solution: Grid, rng: random.Random, *, min_clues: int = 0) -> Grid:
    """Remove clues in random order while the solution stays unique."""
    puzzle = list(solution)
    order = list(range(81))
    rng.shuffle(order)
    clues = 81
    for i in order:
        if clues <= min_clues:
            break
        v = puzzle[i]
        puzzle[i] = 0
        if count_solutions(tuple(puzzle), 2) == 1:
            clues -= 1
        else:
            puzzle[i] = v
    return tuple(puzzle)


def random_puzzle(seed: int, *, min_clues: int = 0) -> tuple[Grid, Grid]:
    """``(givens, solution)`` with a unique solution, reproducible from *seed*."""
    rng = random.Random(seed)
    solution = random_solution(rng)
    return dig(solution, rng, min_clues=min_clues), solution
