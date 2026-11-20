# backend/: agent notes

**Package:** `sudoku_api`. Built on FastAPI with **synchronous** SQLAlchemy 2 sessions, Alembic, Pydantic v2 and pydantic-settings. The contract is `backend/openapi.json`; publish schema changes before implementing (see CLAUDE.md).

## Layout
- `routers/`: HTTP only. `services/`: logic, testable without HTTP. `models/`, `schemas/`.
- `services/puzzle_logic.py` is the **only** module that calls `sudoku_validator` or `sudoku_generator`.
- `services/generation.py`: a spawn-context `ProcessPoolExecutor` (`GENERATOR_PROCESSES`, where 0 means a thread). `workers/pool.py` refills the level with the fewest puzzles first.
- `cli.py`: `sudoku-api seed-pool FILE|-`
- `services/recognition.py` is the **only** module that may import `sudoku_vision` (photo import, PLAN.md §5.6).

## Photo import (§5.6)
- `routers/imports.py` + `services/imports.py` (check, import) + `services/recognition.py` (vision adapter). **The API process must never import `sudoku_vision`/cv2/onnxruntime/PIL (~43 MB):** it is imported lazily inside the worker job, and the job converts the result to backend-local dataclasses (`RecognitionResult`) before returning, because unpickling a vision object would import the stack. `test_vision_isolation.py` checks this in a subprocess with a real process pool.
- **`source` lives on `games` and `puzzles`.** Leaderboard filters `games.source = 'generated'` (an import can reuse a generated row, e.g. a pre-solved known puzzle, and must never rank). `puzzles.source` keeps imported rows out of the pool; `create_game` returns 503 if a generated candidate reuses a row that was imported (`games.was_imported`). Reusing a row for an import deletes its `puzzle_pool` entry in the same transaction.
- `puzzles.difficulty` is nullable (Unrated imports only): use `games.puzzle_difficulty(game)`; scoring uses expert base + 45-min par (`UNRATED_*` in `scoring.py`). `best` scores skip Unrated.
- **Never leak the solution:** `/imports/check` counts solutions and rates the **givens only**; `current` only gets constraint checks (`find_contradiction`). Tests compare a right vs a silently wrong handwritten entry and require identical responses.
- Import gate: consistency + `count_solutions == 1` (sync), then `rate_givens` (= `validate_puzzle(givens)`) in the pool with `IMPORT_RATING_TIMEOUT_SECONDS`, skipped when a finally rated row exists (`needs_rating`).
  - **`puzzles.rating_score` NULL = rating pending** (timeout): `difficulty` NULL is provisional and the next import re-rates and updates the row (migration 0004). Genuinely Unrated = `difficulty` NULL with a non-NULL score; never re-rated.
- `/games/import` is rate-limited (`IMPORT_GAME_RATE_LIMIT`, default 10/minute): each call may insert a permanent row and queue a pool job.
- **CPU work off the loop:** `PuzzleGenerator.run_job(timeout, fn, *args)` runs picklable top-level functions in the generator's spawn pool (a thread when `GENERATOR_PROCESSES=0`, i.e. in tests). Return failures as values (`RecognitionFailure`): `RecognitionError` doesn't survive pickling (its `code` is lost).
- **Uploads:** `uploads.limited_upload_route` (route class on `imports.upload_router`) runs the rate limit and a bearer-header check, rejects big `Content-Length`, then parses multipart itself with a byte-counting stream (413 mid-stream) and **in-memory spooling** (Starlette spools >1 MB parts to disk by default). It caches the form on `request._form` so FastAPI's own parsing reuses it; the OpenAPI form model stays unchanged.
- Never log image bytes or vision exception messages (they may contain them); log the exception type only.
- `recognize` raises `ValueError` for degenerate `corners` (not four finite pairs, zero area): `recognition_job` returns it as `invalid_corners`, which maps to 422 `validation_error`. A `ValueError` without corners is 503. Valid corners that miss the grid only add a warning.
- Timeout tests block fake jobs on a `threading.Event` (`release` fixture) instead of sleeping.
- Tests monkeypatch `recognition.vision_recognize` for error paths (jobs run in a thread in tests). `test_real_recognition_end_to_end` runs the **real** model on `vision/tests/fixtures/synth_7_00.jpg` (read-only, owned by vision) and imports the result; if vision retrains, that fixture must still read exactly.

## Conventions and pitfalls
- **Errors** are always `{"detail", "code"}` with snake_case codes, declared via `error_responses(...)` (`test_openapi` requires every 4xx/5xx to reference `ErrorOut`, except `/health`'s 503). A foreign or missing game returns **404 `not_found`**, never 403.
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
  - `HINT_RATE_LIMIT`, `SEARCH_RATE_LIMIT`, `IMPORT_RATE_LIMIT` (recognize, applied in the upload route class before the body is read), `IMPORT_CHECK_RATE_LIMIT`, and a silent per-address `EMAIL_RATE_LIMIT`.
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
  - `0003` (photo import) has a **lossy downgrade**: it deletes imported games/puzzles, since the old schema can't keep them off the leaderboard.
  - `alembic check` must report no drift.

## Verify
- `./scripts/verify.sh --only backend`, and add `--full` for auth or saving changes.
- Async/background tests synchronise on events (see `test_async_refill_and_worker`), never on wall-clock polling budgets.
- TestClient buffers request bodies before calling the app; test streaming limits at the ASGI level (`read_limited_form` with a counting `receive`).
- On Postgres: `TEST_DATABASE_URL=postgresql+psycopg://... uv run pytest` inside `backend/`.
