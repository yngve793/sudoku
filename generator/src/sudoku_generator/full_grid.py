"""Random complete solution grids via randomized backtracking."""

from __future__ import annotations

import random

from sudoku_validator import Grid

_ALL = 0x3FE  # bits 1..9


def _box(i: int) -> int:
    return (i // 27) * 3 + (i % 9) // 3


def random_full_grid(rng: random.Random) -> Grid:
    """Return a uniformly shuffled-order backtracking fill of an empty grid.

    All randomness comes from *rng*, so the same seeded generator state always
    yields the same grid. Cells are filled in most-constrained-first order,
    trying candidate digits in a random order.
    """
    values = [0] * 81
    rows = [0] * 9
    cols = [0] * 9
    boxes = [0] * 9

    def free(i: int) -> int:
        return _ALL & ~(rows[i // 9] | cols[i % 9] | boxes[_box(i)])

    def fill(remaining: int) -> bool:
        if remaining == 0:
            return True
        # Most-constrained empty cell; ties broken by index (deterministic).
        best = -1
        best_count = 10
        best_mask = 0
        for i in range(81):
            if values[i]:
                continue
            mask = free(i)
            count = mask.bit_count()
            if count < best_count:
                best, best_count, best_mask = i, count, mask
                if count <= 1:
                    break
        if best_count == 0:
            return False
        digits = [d for d in range(1, 10) if best_mask >> d & 1]
        rng.shuffle(digits)
        r, c, b = best // 9, best % 9, _box(best)
        for d in digits:
            bit = 1 << d
            values[best] = d
            rows[r] |= bit
            cols[c] |= bit
            boxes[b] |= bit
            if fill(remaining - 1):
                return True
            rows[r] &= ~bit
            cols[c] &= ~bit
            boxes[b] &= ~bit
        values[best] = 0
        return False

    if not fill(81):  # pragma: no cover - an empty grid is always fillable
        raise RuntimeError("failed to fill an empty grid")
    return tuple(values)
