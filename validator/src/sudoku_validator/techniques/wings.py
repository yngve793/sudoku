"""XY-Wing, XYZ-Wing and W-Wing."""

from __future__ import annotations

from itertools import combinations

from ..grid import PEER_BITS, PEER_SETS, PEERS, SIZE, UNITS, cell_name
from ..state import BIT, DIGITS_OF, POPCOUNT, State, iter_bits
from ..step import Step
from .base import W_WING, XY_WING, XYZ_WING, digits_str, elimination_step


def _targets(state: State, digit: int, see_all: int, exclude: tuple[int, ...]) -> list[int]:
    bit = BIT[digit]
    cands = state.cands
    return [c for c in iter_bits(see_all) if c not in exclude and cands[c] & bit]


def bivalue_cells(state: State) -> list[int]:
    return [i for i in range(SIZE) if POPCOUNT[state.cands[i]] == 2]


def xy_wing(state: State) -> Step | None:
    """Pivot {x,y} sees pincers {x,z} and {y,z}: z is removed from cells seeing both pincers."""
    cands = state.cands
    bivalue = bivalue_cells(state)
    bv = set(bivalue)
    for pivot in bivalue:
        pm = cands[pivot]
        wings = [c for c in PEERS[pivot] if c in bv and POPCOUNT[cands[c] & pm] == 1]
        for a, b in combinations(wings, 2):
            ma, mb = cands[a], cands[b]
            za, zb = ma & ~pm, mb & ~pm
            if za != zb or (ma & pm) == (mb & pm):
                continue
            z = DIGITS_OF[za][0]
            targets = _targets(state, z, PEER_BITS[a] & PEER_BITS[b], (pivot,))
            if targets:
                return elimination_step(
                    XY_WING,
                    [(t, z) for t in targets],
                    [pivot, a, b],
                    f"pivot {cell_name(pivot)} ({digits_str(DIGITS_OF[pm])}) sees "
                    f"{cell_name(a)} ({digits_str(DIGITS_OF[ma])}) and "
                    f"{cell_name(b)} ({digits_str(DIGITS_OF[mb])}); whichever value the pivot "
                    f"takes, one of the pincers must be {z}.",
                )
    return None


def xyz_wing(state: State) -> Step | None:
    """Pivot {x,y,z} sees {x,z} and {y,z}: z is removed from cells seeing all three."""
    cands = state.cands
    bv = set(bivalue_cells(state))
    for pivot in range(SIZE):
        pm = cands[pivot]
        if POPCOUNT[pm] != 3:
            continue
        wings = [c for c in PEERS[pivot] if c in bv and cands[c] & ~pm == 0]
        for a, b in combinations(wings, 2):
            ma, mb = cands[a], cands[b]
            if ma == mb or (ma | mb) != pm:
                continue
            z = DIGITS_OF[ma & mb][0]
            see_all = PEER_BITS[pivot] & PEER_BITS[a] & PEER_BITS[b]
            targets = _targets(state, z, see_all, ())
            if targets:
                return elimination_step(
                    XYZ_WING,
                    [(t, z) for t in targets],
                    [pivot, a, b],
                    f"pivot {cell_name(pivot)} ({digits_str(DIGITS_OF[pm])}) sees "
                    f"{cell_name(a)} ({digits_str(DIGITS_OF[ma])}) and "
                    f"{cell_name(b)} ({digits_str(DIGITS_OF[mb])}); one of these three cells "
                    f"must be {z}.",
                )
    return None


def strong_links(state: State, digit: int) -> list[tuple[int, int, int]]:
    """``(unit, a, b)`` for each unit where *digit* has exactly two candidate cells."""
    bit = BIT[digit]
    cands = state.cands
    links: list[tuple[int, int, int]] = []
    for u, unit in enumerate(UNITS):
        cells = [c for c in unit if cands[c] & bit]
        if len(cells) == 2:
            links.append((u, cells[0], cells[1]))
    return links


def w_wing(state: State) -> Step | None:
    """Two {x,y} cells joined by a strong link on x: y is removed from cells seeing both."""
    cands = state.cands
    bivalue = bivalue_cells(state)
    links_by_digit: dict[int, list[tuple[int, int, int]]] = {}
    for a, b in combinations(bivalue, 2):
        if cands[a] != cands[b] or b in PEER_SETS[a]:
            continue
        common = PEER_BITS[a] & PEER_BITS[b]
        x0, y0 = DIGITS_OF[cands[a]]
        for x, y in ((x0, y0), (y0, x0)):
            targets = _targets(state, y, common, ())
            if not targets:
                continue
            if x not in links_by_digit:
                links_by_digit[x] = strong_links(state, x)
            for _, p, q in links_by_digit[x]:
                for e1, e2 in ((p, q), (q, p)):
                    if e1 in PEER_SETS[a] and e2 in PEER_SETS[b]:
                        return elimination_step(
                            W_WING,
                            [(t, y) for t in targets],
                            [a, b, e1, e2],
                            f"{cell_name(a)} and {cell_name(b)} both hold {x0}/{y0}, and "
                            f"{x} must be in {cell_name(e1)} or {cell_name(e2)}, which see "
                            f"them; so they cannot both be {x}, and one of them is {y}.",
                        )
    return None
