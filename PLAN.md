# Sudoku Web Game — Implementation Plan

## 1. Goals

- Browser-based Sudoku game with a **React** frontend and a **Python** API.
- **Generator** that produces puzzles at four difficulty levels.
- **Validator/checker** that independently proves a puzzle has **exactly one solution** and that its **difficulty rating is accurate**.
- **Hints** served by the backend, explained as logical steps (“Naked single in r3c5 → 7”) rather than just revealing answers.
- **User accounts** stored in a database, with persisted **current board**, **game history** and **scores/leaderboard**.
- Generation, validation and API code live in **separate folders/packages** with clear one-way dependencies.

## 2. Repository layout

```
sudoku/
├── PLAN.md
├── README.md
├── pyproject.toml              # uv workspace root (shared ruff/mypy/pytest config)
├── docker-compose.yml          # postgres + api + frontend (dev & prod-like)
├── .claude/agents/             # sub-agent definitions (one per component)
│
├── validator/                  # package: sudoku_validator  (leaf, no deps on other packages)
│   ├── pyproject.toml
│   ├── src/sudoku_validator/
│   │   ├── grid.py             # Grid type, parse/format, peers/units tables
│   │   ├── solver.py           # fast backtracking solver (bitmasks), count_solutions()
│   │   ├── techniques/         # one module per human technique
│   │   │   ├── singles.py      #   naked single, hidden single
│   │   │   ├── locked.py       #   pointing / claiming (locked candidates)
│   │   │   ├── subsets.py      #   naked/hidden pairs, triples, quads
│   │   │   ├── fish.py         #   X-Wing, Swordfish, Jellyfish
│   │   │   ├── wings.py        #   XY-Wing, XYZ-Wing, W-Wing
│   │   │   ├── chains.py       #   Simple coloring, X-Chain, XY-Chain, forcing chains
│   │   │   ├── uniqueness.py   #   Unique Rectangle types 1–2
│   │   │   └── als.py          #   ALS-XZ
│   │   ├── logical_solver.py   # applies techniques in order, records steps
│   │   ├── rating.py           # Difficulty enum, rate()
│   │   ├── hints.py            # next_hint()
│   │   └── report.py           # validate_puzzle() -> ValidationReport
│   └── tests/
│
├── generator/                  # package: sudoku_generator  (depends on sudoku_validator)
│   ├── pyproject.toml
│   ├── src/sudoku_generator/
│   │   ├── full_grid.py        # random complete solution grid
│   │   ├── digger.py           # removes clues while keeping uniqueness
│   │   ├── generate.py         # generate(difficulty, seed) -> Puzzle
│   │   └── cli.py              # `sudoku-gen --difficulty hard --count 50 --seed 1`
│   └── tests/
│
├── backend/                    # package: sudoku_api  (depends on generator + validator)
│   ├── pyproject.toml
│   ├── alembic/                # DB migrations
│   ├── src/sudoku_api/
│   │   ├── main.py             # FastAPI app factory
│   │   ├── config.py           # pydantic-settings (env vars)
│   │   ├── db.py               # SQLAlchemy engine/session
│   │   ├── models/             # ORM models
│   │   ├── schemas/            # Pydantic request/response models
│   │   ├── routers/            # auth, games, hints, scores, health
│   │   ├── services/           # business logic (game, scoring, puzzle pool)
│   │   ├── security.py         # password hashing, JWT
│   │   └── workers/pool.py     # background puzzle-pool refill
│   └── tests/
│
└── frontend/                   # React + TypeScript (Vite)
    ├── package.json
    ├── src/
    │   ├── api/                # typed client generated from OpenAPI
    │   ├── features/auth/
    │   ├── features/game/      # Board, Cell, NumberPad, Notes, Timer, HintPanel
    │   ├── features/scores/
    │   ├── routes/
    │   └── test/               # MSW handlers, test utils
    └── e2e/                    # Playwright tests
```

**Dependency direction (enforced):** `validator ← generator ← backend`. The frontend talks only to the backend over HTTP. The validator never imports the generator. That keeps it an independent check: the generator's output is never trusted just because the generator produced it.

## 3. Technology choices

| Area | Choice | Why |
|---|---|---|
| Python | 3.12+ managed with **uv** workspaces | Fast, reproducible lockfile, one venv for all three packages |
| Lint/format/types | **ruff**, **mypy --strict** | One fast linter; strict typing on the pure-logic packages |
| Tests (Py) | **pytest**, **hypothesis**, pytest-cov | Property-based tests suit puzzle invariants |
| API | **FastAPI** + **Pydantic v2** | Typed, auto-generated OpenAPI that drives the frontend client |
| ORM / migrations | **SQLAlchemy 2.0** + **Alembic** | Standard and well supported |
| Database | **SQLite** for dev/tests, **PostgreSQL** in docker/prod | No setup for local dev; production-grade in deployment |
| Auth | **Argon2id** hashing (`pwdlib`), **JWT** (PyJWT): short-lived access token + rotating refresh token in an httpOnly cookie | Current best practice; avoids keeping long-lived tokens in localStorage |
| Rate limiting | `slowapi` on auth + hint endpoints | Brute-force and abuse protection |
| Frontend | **React 19 + TypeScript + Vite** | |
| Data fetching | **TanStack Query** | Caching, retries, mutation state |
| Routing | **React Router** | |
| Game state | `useReducer` + context (pure reducer, easy to unit test) | No global store needed |
| API client | `openapi-typescript` generated types + thin fetch wrapper | Frontend and backend contract can't drift |
| Frontend tests | **Vitest** + **Testing Library** + **MSW**; **Playwright** e2e | |
| CI | GitHub Actions: lint → typecheck → test (per package) → build | |

## 4. Core domain model (shared contract)

- **Grid**: `tuple[int, ...]` of length 81, row-major, `0` = empty. String form: 81 chars, `.` or `0` for empty.
- **Difficulty**: `beginner | easy | medium | hard | expert | master | extreme` (7 levels).
- **Difficulty definition**: based on the **hardest technique required** by the logical solver. A score breaks ties and orders puzzles within a level. `beginner` and `easy` use the same techniques and are separated by score band only: beginner always has many singles available, so the next move is easy to find.

| Level | Allowed techniques (hardest needed decides the level) | Clues (measured, 200/level) |
|---|---|---|
| beginner | Naked single, Hidden single (score ≤ 42) | 39–43 |
| easy | Naked single, Hidden single (score > 42) | 24–32 |
| medium | + Locked candidates (pointing/claiming), Naked/Hidden pair | 24–32 |
| hard | + Naked/Hidden triple, X-Wing, XY-Wing | 24–31 |
| expert | + Naked/Hidden quad, Swordfish, XYZ-Wing, Simple coloring / X-Chains, W-Wing | 24–33 |
| master | + Jellyfish, Unique Rectangle (type 1–2), XY-Chains | 24–32 |
| extreme | + ALS-XZ, short forcing chains (bounded depth) | 24–30 |

Puzzles that the logical solver **cannot finish** with these techniques (i.e. they need open-ended guessing) are **rejected**. Clue count is reported but **never** used to decide difficulty, because clue count correlates poorly with how hard a puzzle actually is.

**Why seven levels:**
- Each level adds a distinct, learnable family of techniques, so each step is a real jump in skill.
- Measured on 1,000 random minimal puzzles: hard ≈ 1 %, master ≈ 7 %, extreme ≈ 10–14 %. That's why the mapping above was rebalanced so every level is reachable. The generator therefore needs targeted strategies (e.g. stop digging early) for the *middle* levels, and not only for the top ones. All levels are served from the background pool, so no user ever waits for generation.
- Unique Rectangle is valid only because every puzzle is proven to have a unique solution (validator check 3).

**Rating score** = Σ (technique weight × times used), using the weights below. Each level also has a score band to keep puzzles in a level roughly consistent.

| Technique | Weight |
|---|---|
| Naked single | 1 |
| Hidden single | 2 |
| Locked candidates | 5 |
| Naked/Hidden pair | 8 / 10 |
| Naked/Hidden triple | 15 / 18 |
| X-Wing | 25 |
| Quad | 30 |
| Swordfish | 40 |
| XY-Wing | 40 |
| XYZ-Wing | 50 |
| Jellyfish | 60 |
| Simple coloring / X-Chain | 60 |
| W-Wing | 65 |
| Unique Rectangle | 70 |
| XY-Chain | 90 |
| ALS-XZ | 110 |
| Forcing chain | 150 |

## 5. Component designs

### 5.1 Validator — `validator/` (`sudoku_validator`)

Public API (`sudoku_validator/__init__.py`):

```python
def parse(s: str) -> Grid
def is_consistent(grid: Grid) -> bool                       # no duplicate in any row/col/box
def solve(grid: Grid) -> Grid | None                        # fast backtracking (bitmask + MRV)
def count_solutions(grid: Grid, limit: int = 2) -> int      # stops early at `limit`
def rate(grid: Grid) -> Rating                              # logical solve + classify
def next_hint(givens: Grid, current: Grid, solution: Grid) -> Hint | None
def find_errors(current: Grid, solution: Grid) -> list[int] # indices of wrong user entries
def validate_puzzle(givens: Grid, solution: Grid | None = None,
                    claimed: Difficulty | None = None) -> ValidationReport
```

```python
@dataclass(frozen=True)
class Step:   technique: str; placements: list[tuple[int,int]]; eliminations: list[tuple[int,int]]; cells: list[int]; explanation: str
@dataclass(frozen=True)
class Rating: difficulty: Difficulty | None; score: int; techniques: dict[str,int]; solved_logically: bool; steps: list[Step]
@dataclass(frozen=True)
class Hint:   kind: Literal["error","step"]; technique: str | None; cells: list[int]; value: int | None; explanation: str
@dataclass(frozen=True)
class ValidationReport:
    is_valid: bool; is_consistent: bool; solution_count: int  # 0, 1 or 2 (=“≥2”)
    solution_matches: bool | None; rating: Rating; difficulty_matches: bool | None; errors: list[str]
```

Checks performed by `validate_puzzle`:
1. Shape and value range (81 cells, 0–9).
2. Givens are consistent (no duplicate digits).
3. **Uniqueness**: `count_solutions(limit=2) == 1`.
4. If a solution is supplied, it is complete, valid and equal to the unique solution.
5. The **logical solver** finishes the puzzle without guessing, and its result equals the backtracking solution. This cross-checks the two solvers against each other.
6. The rating is recomputed from scratch and must equal `claimed`.

Hint logic (`next_hint`):
1. If the user has wrong entries, return an `error` hint (“r4c2 is incorrect”) first.
2. Otherwise run the logical solver from the user's **current** state and return the **first** (easiest) available step, together with an explanation and the cells to highlight.
3. The frontend reveals the hint in stages: (a) technique + region, (b) highlighted cells, (c) the value. Each stage costs more points.

Quality bar: ≥ 95 % line coverage. Each technique gets known-answer tests on reference puzzles. Hypothesis properties include: “solve(x) satisfies all constraints” and “every logical step is consistent with the unique solution”.

Performance targets: `count_solutions` < 5 ms typical, `rate` < 50 ms typical.

### 5.2 Generator — `generator/` (`sudoku_generator`)

```python
@dataclass(frozen=True)
class Puzzle: givens: Grid; solution: Grid; difficulty: Difficulty; rating: Rating; seed: int

def generate(difficulty: Difficulty, *, seed: int | None = None,
             symmetry: Symmetry = Symmetry.ROTATIONAL, max_attempts: int = 200) -> Puzzle
```

Algorithm:
1. **Full grid**: randomized backtracking fill using a seeded `random.Random`. Never use the global RNG, so a seed always reproduces the same puzzle.
2. **Dig**: visit cell pairs (rotationally symmetric) in random order. Remove a pair, then keep the removal only if `count_solutions(limit=2) == 1`.
3. **Target difficulty**: after each accepted removal, call `rate()`.
   - When the rating reaches the target level, stop, or keep digging while it stays in the target band.
   - If the rating overshoots or can no longer be solved logically, undo that removal and try the next cell.
   - If the target is not reached, restart with a new full grid (bounded by `max_attempts`).
4. **Final gate**: call `validate_puzzle(givens, solution, claimed=difficulty)` and only return a puzzle whose report has `is_valid=True`.
5. CLI for batch generation, JSON-lines output, and stats (time per level, success rate).

Performance (average):

| Levels | Target |
|---|---|
| beginner, easy, medium | < 200 ms |
| hard | < 1 s |
| expert | < 5 s |
| master, extreme | < 60 s (best effort) |

For master and extreme, the generator digs past the minimal-uniqueness point. It also retries harder full grids with more attempts (`max_attempts` scales by level).

Because the high levels are slow, the backend always serves puzzles from a pre-generated **pool** (see 5.3). A CLI batch job can seed the pool offline, e.g. `sudoku-gen --difficulty extreme --count 200`.

Tests: determinism (same seed gives the same puzzle); every generated puzzle passes `validate_puzzle` (property test across seeds and levels); the difficulty distribution is checked by a benchmark script.

### 5.3 Backend API — `backend/` (`sudoku_api`)

#### Database schema

```
users        id PK, username UNIQUE (public display name), email UNIQUE NOT NULL (stored lower-cased),
             password_hash, email_verified_at NULL, created_at, last_login_at
refresh_tokens id PK, user_id FK, token_hash, expires_at, revoked_at, created_at
email_tokens id PK, user_id FK, purpose (verify_email|reset_password), token_hash UNIQUE,
             expires_at, used_at NULL, created_at          -- single-use, only the hash is stored
puzzles      id PK, givens CHAR(81) UNIQUE, solution CHAR(81), difficulty, rating_score,
             techniques JSON, clue_count, seed, generator_version, created_at, validated_at
puzzle_pool  puzzle_id FK UNIQUE, difficulty, reserved_at NULL   -- unassigned, pre-validated puzzles
games        id PK, user_id FK, puzzle_id FK, status (in_progress|completed|abandoned),
             current CHAR(81), notes JSON (cell -> [candidates]), elapsed_seconds,
             hints_used, mistakes, score NULL, version INT (optimistic lock),
             started_at, updated_at, completed_at
             -- partial unique index: one in_progress game per user
hint_events  id PK, game_id FK, level, technique, cells JSON, created_at
```

#### Endpoints (all under `/api/v1`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Create account `{username, email, password}`; sends verification email; returns 202 |
| POST | `/auth/verify-email` | `{token}` → marks email verified (single-use, 24 h expiry) |
| POST | `/auth/resend-verification` | `{email}` → always 202 (no account enumeration) |
| POST | `/auth/forgot-password` | `{email}` → always 202; sends reset link if account exists |
| POST | `/auth/reset-password` | `{token, new_password}` (single-use, 1 h expiry); revokes all refresh tokens |
| POST | `/auth/login` | Returns access token and sets refresh cookie; **403 `email_not_verified`** if unverified |
| POST | `/auth/refresh` | Rotates refresh token, returns new access token |
| POST | `/auth/logout` | Revokes refresh token |
| GET | `/me` | Current user + stats |
| POST | `/games` | `{difficulty}` → new game (abandons any current one) |
| GET | `/games/current` | Resume the in-progress board |
| GET | `/games/{id}` | Game state (owner only) |
| PATCH | `/games/{id}` | Autosave `{current, notes, elapsed_seconds, version}`; returns 409 on version conflict |
| POST | `/games/{id}/hint` | `{stage: 1|2|3}` → `Hint`; increments hints_used |
| POST | `/games/{id}/check` | Returns indices of wrong cells (counts as a mistake check) |
| POST | `/games/{id}/complete` | Server verifies the board equals the solution, then computes and stores the score |
| GET | `/scores/me` | Personal history and best scores per difficulty |
| GET | `/leaderboard?difficulty=&period=day\|week\|all&limit=` | **Public (no auth)**. Top scores showing username, score, time, hints and date only. Cached ~30 s |
| GET | `/leaderboard/me?difficulty=&period=` | The logged-in user's own rank |
| GET | `/health` | Liveness/readiness |

#### Rules and best practices
- **The solution never leaves the server** (only in responses after completion). Completion and scoring are verified server-side.
- **Layering**: routers stay thin (HTTP only); services hold the logic; models handle persistence. Services are unit tested without HTTP.
- **Puzzle pool**: a background task keeps N validated puzzles per difficulty in `puzzle_pool`. `POST /games` takes one with `SELECT … FOR UPDATE SKIP LOCKED` (Postgres) and falls back to generating synchronously if the pool is empty.
- **Defense in depth**: every puzzle runs through `validate_puzzle` before it is inserted into `puzzles`.
- **Scoring**: `score = base[difficulty] × time_factor − hint_penalty × Σ stage weights − mistake_penalty × mistakes`, floored at 0. The formula lives in `services/scoring.py` and is unit tested.
  - base: beginner 50, easy 100, medium 250, hard 500, expert 1000, master 2000, extreme 4000.
  - time_factor: 1.5 when solved under the par time, decaying to 0.5 at 4× par.
- **Email verification**:
  - Tokens are 32-byte `secrets.token_urlsafe` values. Only their SHA-256 hash is stored; they are single-use and expire.
  - The link in the email points to the frontend: `{FRONTEND_URL}/verify-email?token=…`.
  - Email is sent through an `EmailSender` interface, run as a FastAPI background task:
    - `ConsoleEmailSender` for tests;
    - `SmtpEmailSender` in dev (via **Mailpit** in docker-compose, with a web UI at :8025) and in prod (real SMTP, with credentials from env).
  - Emails use plain-text and HTML templates.
  - Resend and forgot-password are rate-limited per email address and per IP, and always return the same response.
- **Public leaderboard**:
  - Only verified users' completed games appear.
  - It shows `username`, never email.
  - Usernames are 3–20 characters `[A-Za-z0-9_]`; a small reserved/profanity blocklist is enforced at registration.
  - Rank ties are broken by earlier completion time.
- **Security**: Argon2id hashing; JWT with an `exp` claim and the secret from env; refresh-token rotation with reuse detection; strict CORS allow-list; rate limits on `/auth/*` and `/hint`; Pydantic validation on every input (grids validated by regex `^[0-9]{81}$`); no secrets in the repo (`.env.example` only).
- **Config** via `pydantic-settings`; structured JSON logging; consistent error format `{"detail": ..., "code": ...}`.
- **Tests**: pytest + httpx `AsyncClient` against SQLite in-memory; one test module per router; a migration test (upgrade from empty to head).

### 5.4 Frontend — `frontend/`

#### Screens
- **Login / Register**, plus a "Check your email" page after registering, with a resend button and cooldown.
- **Verify email** (`/verify-email?token=`) shows success or failure, with a link to resend.
- **Forgot password / Reset password** (`/reset-password?token=`).
- If login returns `email_not_verified`, show an inline prompt with a resend action.
- **Home**: resume current game, start a new one (choose from 7 difficulties, each with a short description of the techniques it needs), personal stats.
- **Game**:
  - 9×9 board, with given cells styled differently from user entries.
  - Number pad, notes (pencil-mark) mode, erase, undo/redo.
  - Timer that pauses when the tab is hidden.
  - Hint button that reveals stages 1→2→3, with highlighted cells and an explanation.
  - "Check" button; mistake and hint counters; completion dialog showing the score.
- **Leaderboard**: a **public route that works without login**. It filters by difficulty and period (day/week/all) and, when logged in, highlights the user's own rank.

#### Best practices
- Game logic is a **pure reducer** (`gameReducer.ts`) covering place, erase, toggle note, undo, redo, auto-remove notes and conflict highlighting. It has full unit-test coverage.
- **Autosave**: debounced (≈1 s) `PATCH`, and also on `visibilitychange`/`beforeunload`; it sends `version` for optimistic concurrency and shows a "saved" indicator.
- **Auth**: the access token is kept in memory only. The refresh token is in an httpOnly cookie, and the token is refreshed silently on 401.
- **Accessibility**:
  - The grid uses `role="grid"`, and every cell has an `aria-label` such as "row 3 column 5, empty".
  - Full keyboard play: arrow keys, 1–9, Backspace, N for notes, H for hint.
  - Visible focus, and colour is never the only signal; meets WCAG AA contrast.
- Responsive layout (mobile-first) and dark mode.
- Types come from the backend OpenAPI schema (`npm run gen:api`). MSW mocks allow frontend development before the API exists.
- Tooling: ESLint (typescript-eslint, react-hooks, jsx-a11y), Prettier, `tsc --noEmit` in CI.

## 6. Agents and ownership

Each agent is defined in `.claude/agents/` and **owns exactly one folder**. It may read other folders but must not edit them. Changes to a contract (section 5 APIs, endpoints, DB schema) are reported back to the orchestrator rather than made unilaterally.

| Agent | Owns | Depends on |
|---|---|---|
| `sudoku-validator` | `validator/` | — |
| `sudoku-generator` | `generator/` | validator public API |
| `sudoku-api` | `backend/` | generator + validator public API |
| `sudoku-frontend` | `frontend/` | API contract (OpenAPI) |
| `sudoku-docker` | Dockerfiles, `frontend/nginx.conf`, compose files, `.dockerignore`, `docker/`, Docker CI job | everything (read-only) |

Container files inside `backend/` and `frontend/` (`Dockerfile`, `docker-entrypoint.sh`, `nginx.conf`, the dockerignore files) belong to `sudoku-docker`, not to the folder's agent.

The orchestrator (main session) owns the remaining root files: workspace `pyproject.toml`, CI (apart from the docker job), README and this plan.

## 7. Execution phases

| Phase | Work | Agents (parallel where possible) |
|---|---|---|
| 0 | Scaffold the root: uv workspace, folder skeletons, ruff/mypy/pytest config, git init, `.gitignore`, `.env.example` | orchestrator |
| 1 | Validator: grid, solver, techniques, rating, hints, report + tests. In parallel, frontend: board UI, reducer and auth screens against MSW mocks | validator ∥ frontend |
| 2 | Generator: built on the validator, with tests and a difficulty benchmark. In parallel, backend: DB models, migrations, auth, game CRUD (using stub puzzles) | generator ∥ api ∥ frontend |
| 3 | Integration: the backend uses the real generator, puzzle pool, hints, scoring and leaderboard. The frontend switches from MSW to the real API (generated types) | api ∥ frontend |
| 4 | Hardening: Playwright e2e (register → verify email via Mailpit API → play → hint → complete → public leaderboard), docker-compose (postgres, mailpit, api, frontend), CI workflow, README | orchestrator + frontend |

**Definition of done for each phase**: lint, typecheck and tests pass for the touched packages; public APIs match this plan, or the plan is updated.

## 8. Acceptance criteria

- [ ] 100 generated puzzles per level all pass `validate_puzzle` (unique solution, accurate rating). Master and extreme are covered by the slow test suite.
- [ ] An unverified user cannot log in. The verification link works once, then fails. Expired tokens fail. Resend and forgot-password don't reveal whether an account exists.
- [ ] Password reset works and invalidates existing sessions.
- [ ] The public leaderboard loads without login and never exposes email addresses.
- [ ] The validator rejects multi-solution puzzles, inconsistent givens, wrong solutions and mislabelled difficulties (each has a test).
- [ ] A user can register, log in, start a game, close the browser, log back in and resume the exact board (including notes and the timer).
- [ ] Hints explain a valid logical step and are reflected in the score.
- [ ] Completing a game stores a server-verified score, which appears on the leaderboard.
- [ ] The solution is never present in any API response for an in-progress game (verified by a test).
- [ ] CI is green: ruff, mypy, pytest (Python); eslint, tsc, vitest, playwright (frontend).
