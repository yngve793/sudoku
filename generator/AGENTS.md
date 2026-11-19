# generator/: agent notes

**Package:** `sudoku_generator`. It depends on `sudoku_validator` **only through its public API**. Never reimplement solving or rating here; the validator is the independent judge.

## Layout
- `full_grid.py`, `symmetry.py`, `digger.py` (symmetric removal, uniqueness via `count_solutions(limit=2)`)
- `generate.py`: `generate()` and `generate_with_stats()`
- `cli.py`: `sudoku-gen`

## Conventions and pitfalls
- **Randomness:** all of it goes through one injected `random.Random(seed)`. The same seed and symmetry give the same puzzle. `seed=None` draws from `secrets`.
- **CLI seeds:** puzzle *i* uses seed `S+i`, so the output is identical for any `--workers` value.
- **Targeting:** dig to minimal, rate, then binary-search the recorded dig steps for the target level, and refine.
  - Easy levels come from stopping early.
  - hard and above come from restarts. Default `max_attempts` per level: 50 / 50 / 200 / 500 / 500 / 2000 / 2000.
- **Final gate:** `validate_puzzle(..., claimed=difficulty).is_valid` must be True. Never weaken it.
- **Timeouts** are checked between attempts and may overrun by one attempt (< 1.5 s).
- **Clue counts** run lower than PLAN's original estimates; the measured ranges are in PLAN.md §4.
- **Weakest level:** medium (about 13 % of attempts hit), with a p95 just over 200 ms.

## Verify
- `./scripts/verify.sh --only generator`
- slow sweep: `cd generator && uv run pytest --run-slow`
- benchmark: `uv run python generator/scripts/benchmark.py --count 200`
