"""Apply human techniques in order of difficulty and record the steps."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from .grid import Grid
from .state import BIT, State
from .step import Step
from .techniques import TECHNIQUES, UNIQUENESS_TECHNIQUES

#: Every step removes at least one of at most 81 * 9 candidates.
_MAX_STEPS = 81 * 9


@dataclass(frozen=True)
class SolveResult:
    steps: tuple[Step, ...]
    final: State
    solved: bool


def find_step(state: State, *, allow_uniqueness: bool = True) -> Step | None:
    """Return the easiest available step, or ``None`` if every technique fails."""
    for name, finder in TECHNIQUES:
        if not allow_uniqueness and name in UNIQUENESS_TECHNIQUES:
            continue
        step = finder(state)
        if step is not None and _makes_progress(state, step):
            return step
    return None


def _makes_progress(state: State, step: Step) -> bool:
    if any(state.values[c] == 0 for c, _ in step.placements):
        return True
    return any(state.cands[c] & BIT[d] for c, d in step.eliminations)


def iter_steps(state: State, *, allow_uniqueness: bool = True) -> Iterator[tuple[Step, State]]:
    """Yield ``(step, state_after_step)`` until solved, stuck or broken."""
    for _ in range(_MAX_STEPS):
        if state.solved or state.is_broken():
            return
        step = find_step(state, allow_uniqueness=allow_uniqueness)
        if step is None:
            return
        state = state.apply(step)
        yield step, state


def logical_solve(grid: Grid, *, allow_uniqueness: bool = True) -> SolveResult:
    """Solve *grid* (assumed well formed and consistent) with logic only."""
    state = State.from_grid(grid)
    steps: list[Step] = []
    for step, after in iter_steps(state, allow_uniqueness=allow_uniqueness):
        steps.append(step)
        state = after
    solved = state.solved and not state.is_broken()
    return SolveResult(tuple(steps), state, solved)
