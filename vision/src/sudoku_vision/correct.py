"""Constraint-assisted correction of misread **givens** (PLAN.md §5.6 step 6).

Only given cells are ever changed, and only to one of their own top-3
alternatives. Handwritten cells are never corrected toward the solution (that
would leak it); they are only reported when they clash with a given.
"""

from __future__ import annotations

import itertools
import math
import time
from collections.abc import Sequence
from dataclasses import replace
from typing import Final

from sudoku_validator import cell_name, count_solutions, find_contradiction

from .types import CellReading

MAX_SUSPECTS: Final = 8  # lowest-confidence givens considered for single changes
MAX_PAIR_SUSPECTS: Final = 6  # ... and for pairs of changes
TIME_BUDGET_S: Final = 0.5
MIN_ALT_PROB: Final = 0.01  # alternatives less likely than this are never tried
MIN_GIVENS: Final = 17  # fewer givens can never have a unique solution

_PEERS: Final = tuple(
    frozenset(
        j
        for j in range(81)
        if j != i
        and (
            j // 9 == i // 9
            or j % 9 == i % 9
            or (j // 27 == i // 27 and (j % 9) // 3 == (i % 9) // 3)
        )
    )
    for i in range(81)
)


def _givens(cells: Sequence[CellReading]) -> list[int]:
    return [c.digit if c.kind == "given" else 0 for c in cells]


def _status(grid: list[int]) -> str | None:
    """``None`` if consistent with exactly one solution, else a warning text."""
    t = tuple(grid)
    if find_contradiction(t) is not None:
        return "givens contradict each other"
    n = count_solutions(t, 2)
    if n == 0:
        return "givens have no solution"
    if n >= 2:
        return "givens have multiple solutions"
    return None


def _options(cell: CellReading) -> list[tuple[int, float]]:
    """Alternative digits for a given, with the log-likelihood cost of switching."""
    cur = max((p for d, p in cell.alternatives if d == cell.digit), default=cell.confidence)
    out = []
    for d, p in cell.alternatives:
        if d != cell.digit and 1 <= d <= 9 and p >= MIN_ALT_PROB:
            out.append((d, math.log(max(cur, 1e-6)) - math.log(p)))
    return out


def correct_givens(cells: Sequence[CellReading]) -> tuple[tuple[CellReading, ...], tuple[str, ...]]:
    """Try to make the givens consistent and uniquely solvable.

    Returns the (possibly) updated cells and warnings. A correction is accepted
    only if the resulting givens are consistent and have exactly one solution;
    among accepted corrections the most likely one (by the classifier's
    probabilities) wins. Changed cells get ``auto_corrected=True``.
    """
    cells = tuple(cells)
    warnings: list[str] = []
    grid = _givens(cells)
    n_givens = sum(1 for v in grid if v)
    problem = _status(grid) if n_givens else "no givens found"
    if problem is not None and n_givens >= MIN_GIVENS:
        fix = _search(cells, grid)
        if fix:
            out = list(cells)
            for idx, digit in fix.items():
                prob = next((p for d, p in cells[idx].alternatives if d == digit), 0.0)
                out[idx] = replace(cells[idx], digit=digit, confidence=prob, auto_corrected=True)
            cells = tuple(out)
            names = ", ".join(cell_name(i) for i in sorted(fix))
            warnings.append(f"auto-corrected givens: {names}")
            problem = None
    if problem is not None:
        warnings.append(problem)
        if n_givens and n_givens < MIN_GIVENS:
            warnings.append("too few givens for a unique solution")
    warnings.extend(_handwritten_clashes(cells))
    return cells, tuple(warnings)


def _search(cells: tuple[CellReading, ...], grid: list[int]) -> dict[int, int] | None:
    deadline = time.perf_counter() + TIME_BUDGET_S
    given_idx = [i for i, v in enumerate(grid) if v]
    by_conf = sorted(given_idx, key=lambda i: cells[i].confidence)
    contradiction = find_contradiction(tuple(grid))
    first = [i for i in (contradiction.cells if contradiction else ()) if grid[i]]
    suspects = list(dict.fromkeys([*first, *by_conf]))
    options = {i: _options(cells[i]) for i in suspects}

    def accept(changes: dict[int, int]) -> bool:
        trial = grid.copy()
        for i, d in changes.items():
            trial[i] = d
        return _status(trial) is None

    best: tuple[float, dict[int, int]] | None = None
    for i in suspects[: max(MAX_SUSPECTS, len(first))]:
        for d, cost in options[i]:
            if time.perf_counter() > deadline:
                return best[1] if best else None
            if (best is None or cost < best[0]) and accept({i: d}):
                best = (cost, {i: d})
    if best is not None:
        return best[1]
    pair_pool = suspects[: max(MAX_PAIR_SUSPECTS, len(first))]
    for a, b in itertools.combinations(pair_pool, 2):
        for (da, ca), (db, cb) in itertools.product(options[a], options[b]):
            if time.perf_counter() > deadline:
                return best[1] if best else None
            cost = ca + cb
            if (best is None or cost < best[0]) and accept({a: da, b: db}):
                best = (cost, {a: da, b: db})
    return best[1] if best else None


def _handwritten_clashes(cells: tuple[CellReading, ...]) -> list[str]:
    out = []
    for c in cells:
        if c.kind != "handwritten" or not c.digit:
            continue
        clash = sorted(
            j for j in _PEERS[c.index] if cells[j].kind == "given" and cells[j].digit == c.digit
        )
        if clash:
            out.append(
                f"handwritten {cell_name(c.index)} contradicts the given at {cell_name(clash[0])}"
            )
    return out
