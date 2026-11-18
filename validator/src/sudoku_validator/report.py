"""Full puzzle validation: :func:`validate_puzzle`."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .grid import SIZE, Grid, is_complete_solution, is_consistent, is_well_formed
from .rating import Difficulty, Rating, empty_rating, rate_with_result
from .solver import count_solutions, solve


@dataclass(frozen=True)
class ValidationReport:
    """Outcome of :func:`validate_puzzle`.

    ``solution_count`` is 0, 1 or 2 (2 meaning "two or more").
    ``solution_matches`` / ``difficulty_matches`` are ``None`` when no
    solution / claimed difficulty was supplied. ``errors`` lists every failed
    check in human-readable form; ``is_valid`` is true iff it is empty.
    """

    is_valid: bool
    is_consistent: bool
    solution_count: int
    solution_matches: bool | None
    rating: Rating
    difficulty_matches: bool | None
    errors: list[str]


def _shape_errors(grid: object, name: str, *, allow_empty: bool) -> list[str]:
    if not isinstance(grid, Sequence) or isinstance(grid, str):
        return [f"{name} must be a sequence of {SIZE} ints"]
    if len(grid) != SIZE:
        return [f"{name} has {len(grid)} cells, expected {SIZE}"]
    if not is_well_formed(grid):
        return [f"{name} contains values outside 0-9"]
    if not allow_empty and 0 in grid:
        return [f"{name} is incomplete"]
    return []


def validate_puzzle(
    givens: Grid, solution: Grid | None = None, claimed: Difficulty | None = None
) -> ValidationReport:
    """Run the six checks of PLAN.md section 5.1. Never raises.

    1. shape and value range; 2. givens consistent; 3. exactly one solution;
    4. supplied solution complete, valid and equal to the unique solution;
    5. logical solver finishes and agrees with the backtracking solver;
    6. recomputed difficulty equals *claimed*.
    """
    errors = _shape_errors(givens, "givens", allow_empty=True)
    sol_errors = [] if solution is None else _shape_errors(solution, "solution", allow_empty=False)
    if errors:  # givens unusable: nothing else can be checked
        return ValidationReport(
            is_valid=False,
            is_consistent=False,
            solution_count=0,
            solution_matches=None if solution is None else False,
            rating=empty_rating(),
            difficulty_matches=None if claimed is None else False,
            errors=errors + sol_errors,
        )
    claimed_level: Difficulty | None = None
    if claimed is not None:
        try:
            claimed_level = Difficulty(claimed)
        except ValueError:
            sol_errors.append(f"claimed difficulty {claimed!r} is not a known level")
    errors.extend(sol_errors)
    grid = tuple(givens)

    # 2. consistency
    consistent = is_consistent(grid)
    if not consistent:
        errors.append("givens contain a duplicate digit in a row, column or box")
        return ValidationReport(
            False,
            False,
            0,
            None if solution is None else False,
            empty_rating(),
            None if claimed is None else False,
            errors,
        )

    # 3. uniqueness
    count = count_solutions(grid, 2)
    unique = solve(grid) if count == 1 else None
    if count == 0:
        errors.append("puzzle has no solution")
    elif count >= 2:
        errors.append("puzzle has more than one solution")

    # 4. supplied solution
    solution_matches: bool | None = None
    if solution is not None:
        solution_matches = False
        if not sol_errors:
            sol = tuple(solution)
            if not is_complete_solution(sol):
                errors.append("supplied solution breaks the sudoku rules")
            elif any(g and g != s for g, s in zip(grid, sol, strict=True)):
                errors.append("supplied solution contradicts the givens")
            else:
                # A valid completion of a uniquely solvable puzzle is the solution.
                solution_matches = count == 1

    # 5. logical solve, cross-checked against backtracking
    if count == 1:
        rating, result = rate_with_result(grid, count)
        if not rating.solved_logically:
            errors.append("logical solver cannot finish the puzzle without guessing")
        elif result.final.values != unique:
            errors.append("logical solver result differs from the backtracking solution")
            rating = Rating(None, rating.score, rating.techniques, False, rating.steps)
    else:
        rating = empty_rating()

    # 6. difficulty
    difficulty_matches: bool | None = None if claimed is None else False
    if claimed_level is not None:
        difficulty_matches = rating.difficulty is claimed_level
        if not difficulty_matches:
            actual = rating.difficulty.value if rating.difficulty else "unrated"
            errors.append(f"claimed difficulty {claimed_level.value} but puzzle rates {actual}")

    return ValidationReport(
        is_valid=not errors,
        is_consistent=True,
        solution_count=count,
        solution_matches=solution_matches,
        rating=rating,
        difficulty_matches=difficulty_matches,
        errors=errors,
    )
