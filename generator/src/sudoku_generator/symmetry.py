"""Clue-removal symmetries: which cells must be removed together."""

from __future__ import annotations

from enum import StrEnum


class Symmetry(StrEnum):
    """Symmetry kept between the givens of a generated puzzle.

    Every symmetry is an involution, so cells are removed in orbits of one or
    two cells (the centre / axis cells form orbits of one).
    """

    NONE = "none"
    ROTATIONAL = "rotational"  # 180-degree rotation about the centre
    HORIZONTAL = "horizontal"  # mirror across the middle row
    VERTICAL = "vertical"  # mirror across the middle column
    DIAGONAL = "diagonal"  # mirror across the main diagonal

    def partner(self, cell: int) -> int:
        """The cell that must match *cell* (``cell`` itself if on the axis)."""
        r, c = divmod(cell, 9)
        match self:
            case Symmetry.NONE:
                return cell
            case Symmetry.ROTATIONAL:
                return 80 - cell
            case Symmetry.HORIZONTAL:
                return (8 - r) * 9 + c
            case Symmetry.VERTICAL:
                return r * 9 + (8 - c)
            case Symmetry.DIAGONAL:
                return c * 9 + r

    def orbits(self) -> list[tuple[int, ...]]:
        """All cell orbits, each sorted, in ascending order of first cell."""
        seen: set[int] = set()
        result: list[tuple[int, ...]] = []
        for cell in range(81):
            if cell in seen:
                continue
            orbit = tuple(sorted({cell, self.partner(cell)}))
            seen.update(orbit)
            result.append(orbit)
        return result

    def is_symmetric(self, grid: tuple[int, ...]) -> bool:
        """True if the given/empty pattern of *grid* respects this symmetry."""
        return all((grid[i] == 0) == (grid[self.partner(i)] == 0) for i in range(81))
