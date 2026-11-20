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
./docker/smoke-test.sh          # optional: register -> verify via Mailpit -> play -> hints -> photo import -> leaderboard
```

- App: <http://localhost:8080>. nginx serves the SPA and proxies `/api/` to the API on the same origin, which the `SameSite=strict` refresh cookie requires.
- Mailpit (catches verification and password-reset emails): <http://localhost:8025>, bound to localhost only.
- The API (8000) is not published. Postgres is published on `127.0.0.1:5432` only, for DB tools.

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:18.7-alpine` | Data in the `pgdata` named volume |
| `mailpit` | `axllent/mailpit:v1.34.0` | SMTP sink; SMTP stays internal |
| `migrate` | `sudoku-api:local` | One-shot `alembic upgrade head`; the api waits for it to succeed |
| `api` | `sudoku-api:local` | FastAPI, `RUN_MIGRATIONS=false`, generator pool with 2 worker processes |
| `frontend` | `sudoku-frontend:local` | nginx-unprivileged on 8080 |
| `seed` | `sudoku-api:local` | Optional (profile `tools`): pre-fills the puzzle pool |

- **Run exactly one api replica.** The puzzle-pool worker, the rate limiter (`memory://`) and the leaderboard cache are in-process. Don't use `--scale api=N`.
- Compose reads `JWT_SECRET` (required), `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (default `sudoku`) and `APP_URL` (default `http://localhost:8080`, used in email links) from `.env`. `APP_URL` defaults to `http://localhost:${APP_PORT}`. It also passes through the token TTL, rate-limit, pool, leaderboard and log settings. `DATABASE_URL`, `CORS_ORIGINS`, `FRONTEND_URL` and `SMTP_*` in `.env` are for the non-Docker setup and are ignored by compose.
- Host ports, image tags and the `edge` subnet are configurable, with these defaults: `APP_PORT=8080`, `MAILPIT_PORT=8025`, `POSTGRES_PORT=5432`, `API_IMAGE=sudoku-api:local`, `FRONTEND_IMAGE=sudoku-frontend:local`, `FRONTEND_DEV_IMAGE=sudoku-frontend:dev` (dev override) and `EDGE_SUBNET=10.89.28.0/24`, which is also the api's `FORWARDED_ALLOW_IPS`. To run a second, isolated instance next to your own (as `verify.sh --docker` does), override all of them and use another project name, for example `APP_PORT=18080 MAILPIT_PORT=18025 POSTGRES_PORT=15432 API_IMAGE=sudoku-api:verify FRONTEND_IMAGE=sudoku-frontend:verify EDGE_SUBNET=10.89.29.0/24 docker compose -p sudoku-verify up --build -d --wait`. Otherwise the build retags your images, or the ports and subnet collide.
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
./scripts/verify.sh                # lint, format, types, unit tests, build + API contract drift (all areas)
./scripts/verify.sh --e2e          # + Playwright against the mocked API
./scripts/verify.sh --full         # + Playwright against a real backend (ports 8765/5765, temp DB)
./scripts/verify.sh --docker       # + build and smoke-test an isolated compose project (safe while your stack runs)
./scripts/verify.sh --only backend --repeat 5
```

Each Python package has its own `tests` package, so pytest runs per package; a single workspace-wide pytest run fails. The slow generator sweeps run with `cd generator && uv run pytest --run-slow`.

CI runs the same checks ([ci.yml](.github/workflows/ci.yml)). A nightly job ([nightly.yml](.github/workflows/nightly.yml)) runs `verify.sh --full --repeat 5` to catch flaky tests.

## Development with Claude Code agents

Agents are defined in [.claude/agents/](.claude/agents/):
- one per area: `sudoku-validator`, `sudoku-generator`, `sudoku-api`, `sudoku-frontend`, `sudoku-docker`;
- plus a read-only `sudoku-reviewer`.

Where things are defined:
- **Ownership:** [.claude/ownership.toml](.claude/ownership.toml), checked by `scripts/check_ownership.py`.
- **Project rules and the agent report format:** [CLAUDE.md](CLAUDE.md).
- **Per-area handoff notes:** `*/AGENTS.md`.
- **Permission guardrails:** [.claude/settings.json](.claude/settings.json). They deny force-push, global installs and Read/Edit-tool access to `.env` (shell access can't be fully blocked, so CLAUDE.md also forbids it), and ask before commit, push and destructive commands.

Verify everything with `./scripts/verify.sh`. Use `--e2e`, `--full` or `--docker` for the heavier suites, and `--repeat N` to hunt flaky tests.
