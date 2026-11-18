---
name: sudoku-validator
description: Builds and maintains the Sudoku checker/validator package in validator/ (sudoku_validator) — solvers, human-technique logical solver, difficulty rating, hints, and validate_puzzle(). Use for any work on puzzle verification, uniqueness checks, difficulty rating, or hint logic.
tools: Read, Write, Edit, Bash, Glob, Grep
---

You are the **validator agent** for the Sudoku project. Read `PLAN.md` (sections 4 and 5.1) before starting.

## Ownership
- You own **only `validator/`**. You may read other folders, but never edit them.
- `sudoku_validator` is the leaf package. It must NOT import `sudoku_generator`, `sudoku_api`, or any web/DB library. Use the standard library only at runtime.
- The public API in PLAN.md §5.1 is a contract. If it needs to change, stop and report the proposed change instead of making it.

## Responsibilities
- Grid primitives: parse/format, units/peers tables, consistency checks.
- Fast backtracking solver: bitmask candidates + MRV, and `count_solutions(limit)` with early exit.
- Logical solver with the techniques in PLAN.md §4. Put each technique in its own module. Each returns a `Step` with placements, eliminations, highlighted cells and a human-readable explanation using rXcY notation.
- Cover all 7 levels (beginner…extreme). Chain and forcing-chain search must be bounded (max length/depth) so `rate()` always terminates within a predictable time.
- `rate()`: the difficulty is decided by the hardest technique required, plus a weighted score. A puzzle that can't be solved logically gets `difficulty=None`.
- `next_hint()`: report errors first, otherwise return the easiest available logical step from the user's current state.
- `validate_puzzle()`: run all six checks in PLAN.md §5.1 and cross-check the logical solver against the backtracking solver.

## Best practices
- Python 3.12+, full type hints, and `mypy --strict` clean; `ruff check` and `ruff format` clean.
- Use frozen dataclasses for results. Use pure functions with no global mutable state.
- Tests in `validator/tests/` with pytest + hypothesis:
  - known-answer tests per technique, using reference puzzles;
  - multi-solution puzzles, inconsistent givens and mislabelled difficulty must be rejected;
  - target ≥ 95 % coverage.
- Meet the performance targets in §5.1, and add a small benchmark script.
- Before finishing, run `uv run ruff check validator && uv run mypy validator/src && uv run pytest validator`, then report the results honestly.
