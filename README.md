# Sudoku

A web Sudoku game with seven difficulty levels. Every puzzle is proven to have exactly one solution, and its difficulty is rated by the solving techniques it needs. Hints explain a real solving step.

- **Frontend:** React + TypeScript (Vite) — [frontend/](frontend/)
- **API:** FastAPI + SQLAlchemy + Alembic — [backend/](backend/)
- **Generator:** builds puzzles for a target difficulty — [generator/](generator/)
- **Validator:** solver, difficulty rater, hint engine and puzzle checker — [validator/](validator/)

The full design is in [PLAN.md](PLAN.md).

```
validator  ←  generator  ←  backend  ←(HTTP)←  frontend
```

The validator has no dependencies on the other packages, so it can check the generator's output independently. The backend runs every puzzle through `validate_puzzle` before storing it.

## Difficulty levels

| Level | Hardest technique required |
|---|---|
| beginner / easy | Naked and hidden singles (split by score) |
| medium | Locked candidates, naked/hidden pairs |
| hard | Triples, X-Wing, XY-Wing |
| expert | Quads, Swordfish, XYZ-Wing, coloring / X-Chains, W-Wing |
| master | Jellyfish, Unique Rectangle, XY-Chains |
| extreme | ALS-XZ, bounded forcing chains |

Puzzles that need guessing are rejected.

## Quick start (Docker)

```bash
cp .env.example .env            # set JWT_SECRET to a long random string (>= 32 chars)
docker compose up --build -d --wait
./docker/smoke-test.sh          # optional: register -> verify via Mailpit -> play -> hints -> leaderboard
```

- App: <http://localhost:8080>. nginx serves the SPA and proxies `/api/` to the API on the same origin, which the `SameSite=strict` refresh cookie requires.
- Mailpit (catches verification and password-reset emails): <http://localhost:8025>, bound to localhost only.
- The API (8000) and Postgres (5432) are not published.

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:18.7-alpine` | Data in the `pgdata` named volume |
| `mailpit` | `axllent/mailpit:v1.34.0` | SMTP sink; SMTP stays internal |
| `migrate` | `sudoku-api:local` | One-shot `alembic upgrade head`; the api waits for it to succeed |
| `api` | `sudoku-api:local` | FastAPI, `RUN_MIGRATIONS=false`, generator pool with 2 worker processes |
| `frontend` | `sudoku-frontend:local` | nginx-unprivileged on 8080 |
| `seed` | `sudoku-api:local` | Optional (profile `tools`): pre-fills the puzzle pool |

- **Run exactly one api replica.** The puzzle-pool worker, the rate limiter (`memory://`) and the leaderboard cache are in-process. Don't use `--scale api=N`.
- Compose reads `JWT_SECRET` (required), `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (default `sudoku`) and `APP_URL` (default `http://localhost:8080`, used in email links) from `.env`. It also passes through the token TTL, rate-limit, pool, leaderboard and log settings. `DATABASE_URL`, `CORS_ORIGINS`, `FRONTEND_URL` and `SMTP_*` in `.env` are for the non-Docker setup and are ignored by compose.
- All containers run with `no-new-privileges`, all capabilities dropped (Postgres keeps the few its entrypoint needs), a read-only root filesystem with a `tmpfs` for `/tmp`, memory/CPU limits and log rotation. Everything except Postgres runs as a non-root user.
- Pre-fill the pool: `docker compose --profile tools run --rm seed` (defaults to 20 master and 20 extreme puzzles; set `SEED_LEVELS`, `SEED_COUNT`, `SEED_WORKERS` to change this).
- Stop with `docker compose down`; add `-v` to delete the database.

### Hot-reload development in Docker

```bash
docker compose -f docker-compose.yml -f compose.dev.yml up --build
```

- Vite dev server with HMR: <http://localhost:5173> (proxies `/api` to the api).
- API with `uvicorn --reload` on bind-mounted `validator/`, `generator/` and `backend/` sources: <http://localhost:8000/docs>.
- Postgres is published on `127.0.0.1:5432`.
- Dependency or migration changes need `--build`. After a `package-lock.json` change, also pass `-V` so the `node_modules` volume is recreated.

## Local development

Requires [uv](https://docs.astral.sh/uv/) and Node 22.

```bash
uv sync                                                   # Python workspace (validator, generator, backend)
cp .env.example .env                                      # set EMAIL_BACKEND=console to print email links to the log
uv run alembic -c backend/alembic.ini upgrade head
uv run uvicorn sudoku_api.main:app --reload               # http://localhost:8000 (docs at /)

cd frontend && npm install && npm run dev                 # http://localhost:5173, proxies /api to :8000
# or, with no backend at all:
npm run dev:mock                                          # mock API (MSW); demo login demo@example.com / password123
```

Generate puzzles from the command line:

```bash
uv run sudoku-gen --difficulty expert --count 10 --seed 1 --out expert.jsonl
uv run sudoku-api seed-pool expert.jsonl                  # pre-fill the puzzle pool
```

## Checks

```bash
./scripts/check.sh                 # ruff, ruff format, mypy and pytest for each Python package
cd frontend && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

Each Python package has its own `tests` package, so run pytest per package (the script does this); one workspace-wide pytest run will fail. The slow generator sweeps run with `cd generator && uv run pytest --run-slow`.

CI runs the same checks: [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Development with Claude Code agents

Each component has its own sub-agent in [.claude/agents/](.claude/agents/): `sudoku-validator`, `sudoku-generator`, `sudoku-api`, `sudoku-frontend` and `sudoku-docker`. Each agent owns one area: the first four own one folder each; `sudoku-docker` owns the Dockerfiles, `nginx.conf`, the compose files and the `docker/` scripts. Changes to an API contract go through PLAN.md.
