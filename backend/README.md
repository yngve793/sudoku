# sudoku-api (backend)

FastAPI + SQLAlchemy 2 + Alembic backend for the Sudoku game. The design is described in
`PLAN.md` §5.3. All routes live under `/api/v1`; interactive docs are served at `/docs`.

## Running locally

Run all commands from the repository root (the uv workspace).

```bash
uv sync                                   # install the workspace
cp .env.example .env                      # then set JWT_SECRET (>= 32 chars)

# Create or upgrade the database schema (SQLite ./sudoku.db by default)
uv run alembic -c backend/alembic.ini upgrade head

# Start the API with auto-reload
uv run uvicorn sudoku_api.main:app --reload
```

- With `EMAIL_BACKEND=smtp`, mail goes to `SMTP_HOST:SMTP_PORT`. In development, Mailpit
  (`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit:v1.34.0`) shows sent mail at
  http://localhost:8025.
- With `EMAIL_BACKEND=console`, emails, including their verification and reset links, are
  written to the log. Never use this setting in production.
- `COOKIE_SECURE=false` is needed for plain-HTTP local development. Keep it `true` everywhere else.
- For PostgreSQL, set `DATABASE_URL=postgresql+psycopg://user:pass@host/db` and install the
  driver extra: `uv sync --extra postgres` (or `uv add --package sudoku-api psycopg[binary]`).

### Migrations

```bash
uv run alembic -c backend/alembic.ini upgrade head                       # apply
uv run alembic -c backend/alembic.ini revision --autogenerate -m "..."   # after model changes
uv run alembic -c backend/alembic.ini check                              # models vs migrations
```

Every schema change needs a migration. `tests/test_migrations.py` upgrades an empty
database to head, checks that it matches the models, and downgrades again.

### OpenAPI export (for the frontend)

```bash
uv run python backend/scripts/export_openapi.py   # writes backend/openapi.json
```

A test fails when `backend/openapi.json` is out of date.

## Docker

The image is built from the repository root, because it needs the validator and generator
workspace packages:

```bash
docker build -f backend/Dockerfile -t sudoku-api .
```

- The build has two stages. The builder (`python:3.13-slim-trixie` + uv 0.13.9) runs
  `uv sync --frozen --no-dev --package sudoku-api --extra postgres --no-editable`, with the
  third-party dependencies in their own cached layer. The runtime stage contains only the
  virtualenv and the Alembic files, and runs as the non-root user `app` (uid 10001). Size is
  about 240 MB.
- `backend/Dockerfile.dockerignore` is the allow-list for this build. BuildKit uses it
  automatically.
- The image contains the `sudoku-api`, `sudoku-gen`, `alembic` and `uvicorn` commands.
- The entrypoint (`docker-entrypoint.sh`) runs `alembic upgrade head` and then starts uvicorn
  on `0.0.0.0:$PORT` with `--proxy-headers`. Extra arguments are passed on to uvicorn.
  - Set `FORWARDED_ALLOW_IPS` to the reverse proxy's address or subnet. Otherwise every
    client shares the proxy's IP for rate limiting.
  - Set `RUN_MIGRATIONS=false` to skip the migration step.
- The `HEALTHCHECK` polls `/api/v1/health`.

In `docker-compose.yml`:

- A one-shot `migrate` service runs the migrations, and the `api` service starts only after it
  succeeds, with `RUN_MIGRATIONS=false`.
- The api runs as a **single replica**, because the pool worker, the rate limiter
  (`memory://`) and the leaderboard cache are in-process. It uses `PUZZLE_SOURCE=generator` and
  `GENERATOR_PROCESSES=2`.
- Its port is not published. nginx (`frontend`) proxies `/api/` to it, and it trusts
  `X-Forwarded-*` only from that network (`10.89.28.0/24`, outside Docker's default address pools so auto-created networks cannot claim it).
- Pre-seed the pool with the `seed` one-shot (profile `tools`):

  ```bash
  docker compose --profile tools run --rm seed                        # 20 master + 20 extreme
  SEED_LEVELS="hard expert" SEED_COUNT=50 docker compose --profile tools run --rm seed
  ```

  It pipes `sudoku-gen ... --out /dev/stdout` into `sudoku-api seed-pool -`.
- `compose.dev.yml` runs the api with `uvicorn --reload` on the bind-mounted sources and
  publishes it on `127.0.0.1:8000`.

To run the test suite against PostgreSQL instead of in-memory SQLite:

```bash
TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost/sudoku_test \
  uv run --package sudoku-api --extra postgres pytest backend
```

## Checks

```bash
uv run ruff check backend
uv run mypy backend/src
uv run pytest backend
```

Tests use in-memory SQLite and FastAPI's `TestClient`. The tests capture email with
`ConsoleEmailSender` and turn off the rate limits, the pool worker and the leaderboard cache.
Dedicated tests switch each of these back on.

## Layout

```
src/sudoku_api/
  main.py            app factory (create_app) and the lazy `app` for uvicorn
  config.py          pydantic-settings; every option comes from env vars
  db.py              engine and session factory (sync SQLAlchemy 2.0)
  deps.py            DI: settings, DB session, current user, email sender, puzzle source
  errors.py          ApiError and the {"detail", "code"} error format
  security.py        Argon2id hashing, JWT access tokens, opaque token hashing
  ratelimit.py       per-app slowapi Limiter, exposed as FastAPI dependencies
  models/            ORM (users, refresh_tokens, email_tokens, puzzles, puzzle_pool, games, hint_events)
                     games also hold search_tree (JSON) and auto_placements (migration 0002)
  schemas/           Pydantic request and response models (search.py: SearchTree, propagate)
  routers/           thin HTTP layer: auth, me, games (incl. hint/check/complete/search), scores, health
  services/          business logic (auth, games, hints, scoring, pool, stats, email)
    puzzle_logic.py  adapter around sudoku_validator / sudoku_generator (temporary stand-ins)
    puzzle_source.py PuzzleSource protocol, FixturePuzzleSource, GeneratorPuzzleSource
  workers/pool.py    background pool refill loop
alembic/             migrations
scripts/             export_openapi.py
```

## Puzzle logic and the puzzle pool

`services/puzzle_logic.py` is the only place that calls puzzle logic, and it uses the real
`sudoku_validator` and `sudoku_generator`.

- **Insertion gate.** Every puzzle passes `validate_puzzle(givens, solution, claimed=level)`
  before it is inserted into `puzzles`, and is stored with the validator's recomputed rating.
  - Rejected puzzles are logged.
  - Inserts use `ON CONFLICT DO NOTHING` on `givens`, so a duplicate can never crash the worker.
- **Puzzle sources** (`PUZZLE_SOURCE`):
  - `generator` is the default. It stores each puzzle's seed and the installed
    `sudoku-generator` version.
  - `fixture` uses built-in puzzles, labelled with `rate()`. Tests use it because it is fast
    and deterministic.
- **Off the event loop.** Generation is CPU-bound, so it runs in a spawn-context process pool
  of `GENERATOR_PROCESSES` workers (default 2). Set it to 0 to use a worker thread instead.
  Database work runs in threads.
- **Background refill.** The refill keeps `POOL_TARGET_PER_LEVEL` puzzles for each level. It
  adds one puzzle at a time, always to the level with the fewest available puzzles. It gives up
  on a level for the current pass after repeated failures.
- **Empty pool.** If the pool is empty, `POST /games` generates synchronously, still in the
  process pool, with a `GENERATION_TIMEOUT_SECONDS` timeout (default 5).
  - On a timeout or generation failure it returns 503 `puzzle_unavailable`. The player's
    current game is left untouched.
  - If the pool was refilled while generating, the new puzzle goes into the pool instead.
- **Hints.** `services/hints.py` reveals each hint in three stages.
  1. Technique and a region; `cells` holds that row, column or box.
  2. The exact cells, with the value redacted from the explanation.
  3. The value and the full explanation.

## Search mode (PLAN.md §5.5)

- **Persisted tree.** `PATCH /games/{id}` (and `/complete`) accept an optional `search_tree`.
  Omit it to keep the saved tree; send `null` to clear it. Saving it bumps `version` like any
  autosave. `GameOut` returns `search_tree`, `auto_placements` and
  `search_costs: {"auto_placement": 2}`.
- **Validation** (`schemas/search.py`, 422 `validation_error`): `version` 1, 1–500 nodes,
  unique ids of 1–36 characters, exactly one root (no `parent_id`, `choice` or placements),
  every other node has a `choice` and an existing `parent_id`, no cycles, `selected_node_id`
  names a node, cells 0–80, digits 1–9, `root_board` matches `^[0-9]{81}$`, unknown fields are
  rejected, and the serialized tree is at most 256 KB. The service also checks that
  `root_board` keeps the givens (422 `givens_modified`). The tree is stored as is and never
  used for scoring.
- **`POST /games/{id}/search/propagate`** `{board}` calls the validator's constraint-only
  `propagate` (naked and hidden singles until nothing changes or a contradiction appears). It
  returns `{placements, contradiction, penalty, auto_placements}`.
  - Errors: 404 for someone else's game, 409 `game_not_in_progress`, 422 `givens_modified`,
    429 `rate_limited` (`SEARCH_RATE_LIMIT`, default `120/minute` per IP).
  - Each returned placement adds one to `games.auto_placements`. Like hints, it does not
    change `version`.
- **Scoring.** `score_breakdown.search_penalty = AUTO_PLACEMENT_PENALTY (2) × auto_placements`
  is subtracted from the total (still floored at 0). Manual search is free.

### Pre-seeding the pool

```bash
uv run sudoku-gen --difficulty extreme --count 200 --workers 4 --out extreme.jsonl
uv run sudoku-api seed-pool extreme.jsonl          # uses DATABASE_URL (or --database-url)
# in docker compose:  docker compose exec -T api sudoku-api seed-pool - < extreme.jsonl
#                 or: docker compose --profile tools run --rm seed   (see "Docker" above)
```

- Every row passes through the same validation gate.
- Rows whose givens already exist are skipped.
- The command prints the number of rows added, duplicate, rejected and malformed. It exits
  with status 1 if any row was rejected or malformed; the valid rows are committed anyway.
