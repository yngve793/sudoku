"""Chain techniques: Simple Coloring, X-Chain, XY-Chain and bounded Forcing Chains.

All searches are bounded (maximum chain length / propagation depth), so every
call finishes in a predictable amount of time.
"""

from __future__ import annotations

from collections import deque
from itertools import combinations
from typing import Final

from ..grid import PEER_BITS, PEER_SETS, PEERS, SIZE, UNITS, cell_name
from ..state import ALL, BIT, DIGITS_OF, POPCOUNT, State, iter_bits
from ..step import Step
from .base import (
    FORCING_CHAIN,
    SIMPLE_COLORING,
    X_CHAIN,
    XY_CHAIN,
    cells_str,
    elimination_step,
    elims_str,
    make_step,
)
from .wings import bivalue_cells, strong_links

#: Longest X-Chain considered, counted in links (strong + weak).
MAX_X_CHAIN_LINKS: Final = 11
#: Longest XY-Chain considered, counted in cells.
MAX_XY_CHAIN_CELLS: Final = 8
#: Maximum number of placements followed in each branch of a forcing chain.
MAX_FORCING_PLACEMENTS: Final = 24


# ---------------------------------------------------------------------------
# Simple coloring
# ---------------------------------------------------------------------------


def simple_coloring(state: State) -> Step | None:
    """Two-colour the strong-link graph of one digit (colour wrap and colour trap)."""
    digit_cells = state.digit_cells()
    for d in range(1, 10):
        adj: dict[int, list[int]] = {}
        for _, a, b in strong_links(state, d):
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        color: dict[int, int] = {}
        for start in sorted(adj):
            if start in color:
                continue
            groups = _color_component(start, adj, color)
            if groups is None or len(groups[0]) + len(groups[1]) < 4:
                continue
            step = _coloring_step(d, groups, digit_cells[d])
            if step is not None:
                return step
    return None


def _color_component(
    start: int, adj: dict[int, list[int]], color: dict[int, int]
) -> tuple[list[int], list[int]] | None:
    color[start] = 0
    queue = deque([start])
    groups: tuple[list[int], list[int]] = ([start], [])
    ok = True
    while queue:
        c = queue.popleft()
        for n in adj[c]:
            if n not in color:
                color[n] = 1 - color[c]
                groups[color[n]].append(n)
                queue.append(n)
            elif color[n] == color[c]:
                ok = False  # odd cycle: impossible in a consistent grid; ignore
    return groups if ok else None


def _coloring_step(d: int, groups: tuple[list[int], list[int]], cells_d: int) -> Step | None:
    pattern = sorted(groups[0] + groups[1])
    desc = f"colour A = {cells_str(sorted(groups[0]))}, colour B = {cells_str(sorted(groups[1]))}"
    for col in (0, 1):
        for a, b in combinations(groups[col], 2):
            if b in PEER_SETS[a]:
                elims = [(c, d) for c in groups[col]]
                name = "AB"[col]
                return elimination_step(
                    SIMPLE_COLORING,
                    elims,
                    pattern,
                    f"the strong links on {d} give {desc}; exactly one colour is {d}. "
                    f"{cell_name(a)} and {cell_name(b)} both have colour {name} and see each "
                    f"other, so colour {name} cannot be {d}.",
                )
    seen = [0, 0]
    for col in (0, 1):
        for c in groups[col]:
            seen[col] |= PEER_BITS[c]
    members = sum(1 << c for c in pattern)
    targets = list(iter_bits(cells_d & seen[0] & seen[1] & ~members))
    if not targets:
        return None
    return elimination_step(
        SIMPLE_COLORING,
        [(t, d) for t in targets],
        pattern,
        f"the strong links on {d} give {desc}; exactly one colour is {d}, and "
        f"{cells_str(targets)} see cells of both colours.",
    )


# ---------------------------------------------------------------------------
# Generic bounded BFS over an implication graph
# ---------------------------------------------------------------------------

# A node is (cell, digit, truth) packed as an int: (cell * 10 + digit) * 2 + truth.


def _node(cell: int, digit: int, truth: int) -> int:
    return (cell * 10 + digit) * 2 + truth


def _unpack(node: int) -> tuple[int, int, int]:
    rest, truth = divmod(node, 2)
    cell, digit = divmod(rest, 10)
    return cell, digit, truth


def _path(parent: dict[int, int], node: int) -> list[int]:
    path = [node]
    while parent[path[-1]] != -1:
        path.append(parent[path[-1]])
    path.reverse()
    return path


def _x_chain_text(path: list[int]) -> str:
    """``r1c1=r1c5-r4c5=r4c8``: ``=`` strong link, ``-`` weak link (first link strong)."""
    out = cell_name(_unpack(path[0])[0])
    for k, node in enumerate(path[1:]):
        out += ("=" if k % 2 == 0 else "-") + cell_name(_unpack(node)[0])
    return out


def _xy_chain_text(path: list[int]) -> str:
    """``r1c1(3=5)-r1c7(5=8)``: in-cell strong links joined by weak links."""
    parts = []
    for k in range(0, len(path) - 1, 2):
        cell, a, _ = _unpack(path[k])
        _, b, _ = _unpack(path[k + 1])
        parts.append(f"{cell_name(cell)}({a}={b})")
    return "-".join(parts)


# ---------------------------------------------------------------------------
# X-Chain
# ---------------------------------------------------------------------------


def x_chain(state: State) -> Step | None:
    """Alternating strong/weak chain on one digit; cells seeing both ends lose the digit."""
    digit_cells = state.digit_cells()
    for d in range(1, 10):
        strong: dict[int, list[int]] = {}
        for _, a, b in strong_links(state, d):
            strong.setdefault(a, []).append(b)
            strong.setdefault(b, []).append(a)
        if len(strong) < 4:
            continue
        cells_d = digit_cells[d]
        best: tuple[int, list[int], list[int]] | None = None
        for start in sorted(strong):
            found = _x_chain_from(start, d, strong, cells_d)
            if found is not None and (best is None or len(found[0]) < len(best[1])):
                best = (start, found[0], found[1])
        if best is not None:
            _, path, targets = best
            cells = [_unpack(n)[0] for n in path]
            ends = (cells[0], cells[-1])
            return elimination_step(
                X_CHAIN,
                [(t, d) for t in targets],
                cells,
                f"the chain {_x_chain_text(path)} (= strong link, - weak link) proves that "
                f"{cell_name(ends[0])} or {cell_name(ends[1])} is {d}; "
                f"{cells_str(targets)} see both ends.",
            )
    return None


def _x_chain_from(
    start: int, d: int, strong: dict[int, list[int]], cells_d: int
) -> tuple[list[int], list[int]] | None:
    root = _node(start, d, 0)
    parent = {root: -1}
    frontier = [root]
    for depth in range(1, MAX_X_CHAIN_LINKS + 1):
        nxt: list[int] = []
        for node in frontier:
            cell, _, truth = _unpack(node)
            if truth == 0:
                neighbours: list[int] = strong.get(cell, [])
            else:
                neighbours = list(iter_bits(PEER_BITS[cell] & cells_d))
            for n in neighbours:
                child = _node(n, d, 1 - truth)
                if child in parent:
                    continue
                parent[child] = node
                nxt.append(child)
                if truth == 0 and depth >= 3 and n != start:
                    targets = cells_d & PEER_BITS[start] & PEER_BITS[n]
                    if targets:
                        return _path(parent, child), list(iter_bits(targets))
        frontier = nxt
        if not frontier:
            break
    return None


# ---------------------------------------------------------------------------
# XY-Chain
# ---------------------------------------------------------------------------


def xy_chain(state: State) -> Step | None:
    """Chain of bivalue cells; if the start is not x the end is x."""
    cands = state.cands
    bivalue = bivalue_cells(state)
    bv_bits = sum(1 << c for c in bivalue)
    digit_cells = state.digit_cells()
    best: tuple[list[int], list[int], int] | None = None
    for start in bivalue:
        for x in DIGITS_OF[cands[start]]:
            found = _xy_chain_from(state, start, x, bv_bits, digit_cells)
            if found is not None and (best is None or len(found[0]) < len(best[0])):
                best = (found[0], found[1], x)
    if best is None:
        return None
    path, targets, x = best
    cells = list(dict.fromkeys(_unpack(n)[0] for n in path))
    return elimination_step(
        XY_CHAIN,
        [(t, x) for t in targets],
        cells,
        f"the chain of two-candidate cells {_xy_chain_text(path)} proves that "
        f"{cell_name(cells[0])} or {cell_name(cells[-1])} is {x}; "
        f"{cells_str(targets)} see both ends.",
    )


def _xy_chain_from(
    state: State, start: int, x: int, bv_bits: int, digit_cells: list[int]
) -> tuple[list[int], list[int]] | None:
    cands = state.cands
    root = _node(start, x, 0)
    parent = {root: -1}
    frontier = [root]
    max_links = 2 * MAX_XY_CHAIN_CELLS - 1
    for depth in range(1, max_links + 1):
        nxt: list[int] = []
        for node in frontier:
            cell, digit, truth = _unpack(node)
            children: list[int]
            if truth == 0:
                other = DIGITS_OF[cands[cell] & ~BIT[digit]][0]
                children = [_node(cell, other, 1)]
            else:
                peers = PEER_BITS[cell] & bv_bits & digit_cells[digit]
                children = [_node(n, digit, 0) for n in iter_bits(peers)]
            for child in children:
                if child in parent:
                    continue
                parent[child] = node
                nxt.append(child)
                c_cell, c_digit, c_truth = _unpack(child)
                if c_truth == 1 and c_digit == x and c_cell != start and depth >= 5:
                    targets = digit_cells[x] & PEER_BITS[start] & PEER_BITS[c_cell]
                    if targets:
                        return _path(parent, child), list(iter_bits(targets))
        frontier = nxt
        if not frontier:
            break
    return None


# ---------------------------------------------------------------------------
# Forcing chains (bounded singles propagation)
# ---------------------------------------------------------------------------


class _Branch:
    """Result of assuming one placement and following singles."""

    __slots__ = ("cands", "contradiction", "placed", "values")

    def __init__(
        self, contradiction: bool, placed: dict[int, int], values: list[int], cands: list[int]
    ) -> None:
        self.contradiction = contradiction
        self.placed = placed
        self.values = values
        self.cands = cands

    def possible(self, cell: int) -> int:
        v = self.values[cell]
        return BIT[v] if v else self.cands[cell]


def _propagate(state: State, cell: int, digit: int, limit: int) -> _Branch:
    values = list(state.values)
    cands = list(state.cands)
    placed: dict[int, int] = {}
    queue: list[tuple[int, int]] = [(cell, digit)]

    def fail() -> _Branch:
        return _Branch(True, placed, values, cands)

    while queue:
        while queue:
            c, d = queue.pop(0)
            if values[c]:
                if values[c] != d:
                    return fail()
                continue
            bit = BIT[d]
            if not cands[c] & bit:
                return fail()
            values[c] = d
            cands[c] = 0
            placed[c] = d
            if len(placed) >= limit:
                return _Branch(False, placed, values, cands)
            for p in PEERS[c]:
                m = cands[p]
                if m & bit:
                    m &= ~bit
                    cands[p] = m
                    if m == 0:
                        return fail()
                    if POPCOUNT[m] == 1:
                        queue.append((p, DIGITS_OF[m][0]))
        for unit in UNITS:
            once = twice = done = 0
            for c in unit:
                m = cands[c]
                twice |= once & m
                once |= m
                done |= BIT[values[c]]
            missing = ALL & ~done
            if missing & ~once:
                return fail()
            for d in DIGITS_OF[once & ~twice & missing]:
                bit = BIT[d]
                queue.append((next(c for c in unit if cands[c] & bit), d))
    return _Branch(False, placed, values, cands)


def _premises(state: State) -> list[tuple[str, list[tuple[int, int]]]]:
    """Either/or premises: bivalue cells, then digits with two places in a unit."""
    out: list[tuple[str, list[tuple[int, int]]]] = []
    cands = state.cands
    for c in bivalue_cells(state):
        a, b = DIGITS_OF[cands[c]]
        out.append((f"{cell_name(c)} is {a} or {b}", [(c, a), (c, b)]))
    seen: set[tuple[int, int, int]] = set()
    for d in range(1, 10):
        for _, p, q in strong_links(state, d):
            if (p, q, d) in seen:
                continue
            seen.add((p, q, d))
            out.append((f"{d} goes in {cell_name(p)} or {cell_name(q)}", [(p, d), (q, d)]))
    return out


def forcing_chain(state: State) -> Step | None:
    """Try both sides of an either/or premise, following singles to a bounded depth.

    A side that leads to a contradiction is false; a conclusion reached on both
    sides is true.
    """
    for premise, options in _premises(state):
        branches = [_propagate(state, c, d, MAX_FORCING_PLACEMENTS) for c, d in options]
        bad = [b.contradiction for b in branches]
        if all(bad):
            continue
        cells = [c for c, _ in options]
        if any(bad):
            k = bad.index(True)
            wrong_c, wrong_d = options[k]
            good_c, good_d = options[1 - k]
            return make_step(
                FORCING_CHAIN,
                placements=[(good_c, good_d)],
                cells=cells,
                explanation=(
                    f"Forcing Chain: {premise}. Assuming {cell_name(wrong_c)} = {wrong_d} "
                    f"and following singles leads to a contradiction, so "
                    f"{cell_name(good_c)} = {good_d}."
                ),
            )
        first, second = branches
        common = sorted(
            (c, v)
            for c, v in first.placed.items()
            if second.placed.get(c) == v and state.values[c] == 0
        )
        if common:
            return make_step(
                FORCING_CHAIN,
                placements=common,
                cells=cells + [c for c, _ in common],
                explanation=(
                    f"Forcing Chain: {premise}. Following singles from either possibility "
                    f"gives {', '.join(f'{cell_name(c)} = {v}' for c, v in common)}, so this "
                    f"must be true."
                ),
            )
        elims = [
            (c, d)
            for c in range(SIZE)
            if state.values[c] == 0
            for d in DIGITS_OF[state.cands[c] & ~(first.possible(c) | second.possible(c))]
        ]
        if elims:
            return make_step(
                FORCING_CHAIN,
                eliminations=elims,
                cells=cells,
                explanation=(
                    f"Forcing Chain: {premise}. Following singles from either possibility "
                    f"removes the same candidates: {elims_str(elims)}."
                ),
            )
    return None
