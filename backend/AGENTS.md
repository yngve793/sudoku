# backend/: agent notes

**Package:** `sudoku_api`. Built on FastAPI with **synchronous** SQLAlchemy 2 sessions, Alembic, Pydantic v2 and pydantic-settings. The contract is `backend/openapi.json`; publish schema changes before implementing (see CLAUDE.md).

## Layout
- `routers/`: HTTP only. `services/`: logic, testable without HTTP. `models/`, `schemas/`.
- `services/puzzle_logic.py` is the **only** module that calls `sudoku_validator` or `sudoku_generator`.
- `services/generation.py`: a spawn-context `ProcessPoolExecutor` (`GENERATOR_PROCESSES`, where 0 means a thread). `workers/pool.py` refills the level with the fewest puzzles first.
- `cli.py`: `sudoku-api seed-pool FILE|-`

## Conventions and pitfalls
- **Errors** are always `{"detail", "code"}` with snake_case codes. A foreign or missing game returns **404 `not_found`**, never 403.
- **The solution never appears** in any response for an in-progress game. Tests assert this for games, hints and propagate.
- **Versions:** PATCH bumps `version`, and a mismatch returns 409 `version_conflict`. Hints, check and propagate do **not** bump `version`.
- **SearchTree validation is strict:**
  - unknown keys are rejected and every field is required;
  - limits: 500 nodes, 81 placements per node, 256 KB.
  - Changing the shape breaks stored trees and the frontend, so treat it as a contract change.
- **Insertion gate:** every puzzle passes `validate_puzzle` before it is inserted. Inserts use `ON CONFLICT (givens) DO NOTHING`.
- **Rate limits:**
  - `AUTH_RATE_LIMIT` (strict) covers login, register and the email flows;
  - `REFRESH_RATE_LIMIT` covers refresh and logout;
  - `HINT_RATE_LIMIT`, `SEARCH_RATE_LIMIT`, and a silent per-address `EMAIL_RATE_LIMIT`.
  - Storage is in-memory, so there must be a **single API process**.
- **Registration doesn't reveal accounts:** register, resend and forgot-password give the same response whether or not the account exists.
- **Scoring constants** live in `services/scoring.py`:
  - hint stage weights 1/2/4 × 10;
  - 15 points per mistake;
  - 2 points per auto-filled search cell;
  - par times of 5 to 60 minutes.
- **Settings:** `.env` is loaded from `.` and `..`, and unknown keys are ignored. Environment variables win over `.env`.
- **Logging:** health-check requests are filtered out of the uvicorn access log.
- **Migrations:**
  - every schema change gets an Alembic revision, using batch mode for SQLite;
  - `test_migrations.py` checks upgrade, downgrade and data survival.
  - `alembic check` must report no drift.

## Verify
- `./scripts/verify.sh --only backend`, and add `--full` for auth or saving changes.
- On Postgres: `TEST_DATABASE_URL=postgresql+psycopg://... uv run pytest` inside `backend/`.
