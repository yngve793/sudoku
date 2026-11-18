"""Human solving techniques, one family per module.

Every technique is a pure function ``State -> Step | None`` that returns the
first deduction it finds (in a deterministic order) or ``None``.
"""

from __future__ import annotations

from typing import Final

from .als import als_xz
from .base import (
    ALS_XZ,
    FORCING_CHAIN,
    HIDDEN_PAIR,
    HIDDEN_QUAD,
    HIDDEN_SINGLE,
    HIDDEN_TRIPLE,
    JELLYFISH,
    LOCKED_CANDIDATES,
    NAKED_PAIR,
    NAKED_QUAD,
    NAKED_SINGLE,
    NAKED_TRIPLE,
    SIMPLE_COLORING,
    SWORDFISH,
    TECHNIQUE_WEIGHTS,
    UNIQUE_RECTANGLE,
    W_WING,
    X_CHAIN,
    X_WING,
    XY_CHAIN,
    XY_WING,
    XYZ_WING,
    Finder,
)
from .chains import forcing_chain, simple_coloring, x_chain, xy_chain
from .fish import jellyfish, swordfish, x_wing
from .locked import locked_candidates
from .singles import hidden_single, naked_single
from .subsets import (
    hidden_pair,
    hidden_quad,
    hidden_triple,
    naked_pair,
    naked_quad,
    naked_triple,
)
from .uniqueness import unique_rectangle
from .wings import w_wing, xy_wing, xyz_wing

#: All techniques in the order the logical solver tries them: by difficulty level,
#: then by weight. Trying every technique of a level before any technique of the
#: next level guarantees the rating uses the lowest level that works greedily.
TECHNIQUES: Final[tuple[tuple[str, Finder], ...]] = (
    (NAKED_SINGLE, naked_single),
    (HIDDEN_SINGLE, hidden_single),
    (LOCKED_CANDIDATES, locked_candidates),
    (NAKED_PAIR, naked_pair),
    (HIDDEN_PAIR, hidden_pair),
    (NAKED_TRIPLE, naked_triple),
    (HIDDEN_TRIPLE, hidden_triple),
    (X_WING, x_wing),
    (XY_WING, xy_wing),
    (NAKED_QUAD, naked_quad),
    (HIDDEN_QUAD, hidden_quad),
    (SWORDFISH, swordfish),
    (XYZ_WING, xyz_wing),
    (SIMPLE_COLORING, simple_coloring),
    (X_CHAIN, x_chain),
    (W_WING, w_wing),
    (JELLYFISH, jellyfish),
    (UNIQUE_RECTANGLE, unique_rectangle),
    (XY_CHAIN, xy_chain),
    (ALS_XZ, als_xz),
    (FORCING_CHAIN, forcing_chain),
)

#: Techniques that rely on the puzzle having a unique solution.
UNIQUENESS_TECHNIQUES: Final = frozenset({UNIQUE_RECTANGLE})

__all__ = ["TECHNIQUES", "TECHNIQUE_WEIGHTS", "UNIQUENESS_TECHNIQUES", "Finder"]
