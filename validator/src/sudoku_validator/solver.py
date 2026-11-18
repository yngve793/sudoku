"""Fast backtracking solver: bitmask candidates, constraint propagation and MRV.

Each search node propagates naked and hidden singles before branching on the
cell with the fewest candidates, which keeps the tree tiny even for very hard
puzzles.
"""

from __future__ import annotations

from typing import Final

from .grid import PEERS, SIZE, UNITS, Grid, is_well_formed, require_len

_ALL: Final = 0x3FE  # bits 1..9
_POP: Final[tuple[int, ...]] = tuple(bin(m).count("1") for m in range(1024))


def _propagate(values: list[int], cands: list[int], queue: list[tuple[int, int]]) -> bool:
    """Apply queued placements plus all resulting singles in place.

    Returns False on contradiction.
    """
    while True:
        while queue:
            c, d = queue.pop()
            v = values[c]
            if v:
                if v != d:
                    return False
                continue
            bit = 1 << d
            if not cands[c] & bit:
                return False
            values[c] = d
            cands[c] = bit
            for p in PEERS[c]:
                m = cands[p]
                if m & bit:
                    m ^= bit
                    if not m:
                        return False
                    cands[p] = m
                    if not m & (m - 1):
                        queue.append((p, m.bit_length() - 1))
        for unit in UNITS:
            once = twice = 0
            for c in unit:
                m = cands[c]
                twice |= once & m
                once |= m
            if once != _ALL:
                return False
            only = once & ~twice
            if only:
                for c in unit:
                    if not values[c]:
                        m = cands[c] & only
                        if m:
                            if m & (m - 1):
                                return False
                            queue.append((c, m.bit_length() - 1))
        if not queue:
            return True


def _search(values: list[int], cands: list[int], limit: int, found: list[Grid]) -> None:
    best = -1
    best_count = 10
    for i in range(SIZE):
        if not values[i]:
            n = _POP[cands[i]]
            if n < best_count:
                best, best_count = i, n
                if n == 2:
                    break
    if best < 0:
        found.append(tuple(values))
        return
    mask = cands[best]
    while mask:
        bit = mask & -mask
        mask ^= bit
        v2 = values[:]
        c2 = cands[:]
        if _propagate(v2, c2, [(best, bit.bit_length() - 1)]):
            _search(v2, c2, limit, found)
            if len(found) >= limit:
                return


def _run(grid: Grid, limit: int) -> list[Grid]:
    require_len(grid)
    if not is_well_formed(grid):
        return []
    values = [0] * SIZE
    cands = [_ALL] * SIZE
    givens = [(i, v) for i, v in enumerate(grid) if v]
    # Reject clashing givens up front (propagation alone would also catch them).
    for i, v in givens:
        if any(grid[p] == v for p in PEERS[i]):
            return []
    if not _propagate(values, cands, givens):
        return []
    found: list[Grid] = []
    _search(values, cands, limit, found)
    return found


def solve(grid: Grid) -> Grid | None:
    """Return the first solution found by backtracking, or ``None``.

    Returns ``None`` for unsolvable, inconsistent or malformed (values outside
    0..9) grids. Raises :class:`ValueError` if the grid does not have 81 cells.
    Uniqueness is not checked; use :func:`count_solutions` for that.
    """
    found = _run(grid, 1)
    return found[0] if found else None


def count_solutions(grid: Grid, limit: int = 2) -> int:
    """Count solutions, stopping early once *limit* have been found.

    The result is ``min(actual, limit)``; with the default ``limit=2`` a value
    of 2 means "two or more". Malformed or inconsistent grids have 0 solutions.
    """
    if limit <= 0:
        require_len(grid)
        return 0
    return min(len(_run(grid, limit)), limit)
