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

### 5.5 Search mode (what-if exploration tree)

The player explores hypotheses ("what if r3c5 = 7?") as a **directed tree** of choices, follows their implications, and sees which branches end in a contradiction.

#### Concepts
- **Root**: a snapshot of the main board (`root_board`) taken when the tree is created. Givens are always preserved.
- **Node**: one choice plus the implications the player (or auto mode) derived from it.
  - Every node except the root has a `choice` `{cell, value}`.
  - It holds a list of `placements` `{cell, value, source: "manual" | "auto"}`.
  - A node's board = `root_board` + every choice and placement on the path from the root to that node.
- **Branching**: each distinct choice at a node is its own child, so siblings are alternatives. "Branch on all candidates" for a selected cell creates **one child per candidate** of that cell. The candidates come from constraints only.
- **Implications**:
  - **Manual mode** (free): the player enters digits into the selected node; these are `manual` placements.
  - **Auto mode** (costs points): after every new choice or manual placement, the server returns all *direct implications*. These are naked and hidden singles repeated until nothing changes. They are appended as `auto` placements.
- **Contradiction** (both modes; a constraint check, **never** a comparison with the solution). Kinds:
  - `duplicate`: a digit twice in a row, column or box;
  - `no_candidates`: an empty cell with no possible digit;
  - `digit_nowhere`: a digit that can't be placed anywhere in a unit where it's still missing.

  A node with a contradiction is **dead**: it's drawn with a cross (✗) and can't get children. If the children made by "branch on all candidates" for one cell are *all* dead, their parent is dead too ("every option for r3c5 fails"), and this repeats up the tree.
- **Solved**: a node whose board is complete and has no contradiction is marked ✓.
- **Apply branch**: copies every choice and placement on the path from the root to the selected node onto the main board, as one undoable action. It's disabled for dead nodes.

#### Validator API additions (`sudoku_validator`)
```python
@dataclass(frozen=True)
class Contradiction:
    kind: Literal["duplicate", "no_candidates", "digit_nowhere"]
    cells: tuple[int, ...]          # cells involved (duplicates, the empty cell, or the unit's empty cells)
    digit: int | None               # the digit for duplicate / digit_nowhere
    unit: str | None                # "row 3" / "column 5" / "box 2" (1-based), None for no_candidates
    explanation: str                # e.g. "7 appears twice in row 3 (r3c2, r3c8)."

@dataclass(frozen=True)
class Placement:
    cell: int; value: int
    technique: Literal["Naked Single", "Hidden Single"]

@dataclass(frozen=True)
class Propagation:
    placements: tuple[Placement, ...]   # in the order they were found
    contradiction: Contradiction | None # first contradiction found (stops propagation)
    grid: Grid                          # resulting grid

def find_contradiction(grid: Grid) -> Contradiction | None
def propagate(grid: Grid, *, max_placements: int = 81) -> Propagation
```
- Both are **constraint-only**: they never consult the solution.
- `propagate` on an already-contradictory grid returns no placements and the contradiction.

#### Backend changes
- **DB**: `games.search_tree JSON NULL` and `games.auto_placements INT NOT NULL DEFAULT 0` (migration `0002`).
- **`GameOut`** adds `search_tree: SearchTree | null`, `auto_placements: int` and `search_costs: {"auto_placement": int}`.
- **`PATCH /games/{id}`** accepts an optional `search_tree`; `null` clears it. Server-side validation:
  - `version == 1`, at most 500 nodes, unique string ids (≤ 36 characters);
  - exactly one root (`parent_id = null`, `choice = null`, no placements); every `parent_id` refers to an existing node;
  - cells 0–80, values 1–9;
  - `root_board` keeps the givens;
  - the serialized size is ≤ 256 KB.
  - The structure is stored as is; scoring never trusts it.
- **`POST /games/{id}/search/propagate`** `{board}` → `{placements: [{cell, value, technique}], contradiction: Contradiction | null, penalty, auto_placements}`.
  - `board` is an 81-character string that must keep the givens (otherwise 422 `givens_modified`).
  - 409 `game_not_in_progress`.
  - Rate limit `SEARCH_RATE_LIMIT` (default `120/minute`).
  - The server adds `len(placements)` to `auto_placements`. `penalty = len(placements) × AUTO_PLACEMENT_PENALTY`. It is treated like hints for `version`, so autosave doesn't conflict.
- **Scoring**:
  - `AUTO_PLACEMENT_PENALTY = 2` points per auto-filled cell.
  - `score_breakdown` adds `search_penalty = auto_placements × 2`.
  - Manual search is free.
- **Persisted tree shape (`SearchTree`)**:
  ```json
  { "version": 1, "root_board": "81 chars", "mode": "manual" | "auto", "selected_node_id": "id",
    "nodes": [ { "id": "n1", "parent_id": null, "choice": null, "placements": [],
                 "status": "open" | "dead" | "solved", "contradiction": Contradiction | null,
                 "branch_cell": int | null, "collapsed": false } ] }
  ```
  `branch_cell` is set on a parent when its children were created by "branch on all candidates". It is needed for the dead-propagation rule.

#### Frontend
- **Search toggle** in the game controls (key `S`). In search mode:
  - the board shows the selected node's board and the main board can't be edited;
  - choice cells are outlined, manual placements look like normal entries, auto placements use a distinct colour and style, and contradiction cells are highlighted.
- **Actions**:
  - **Guess** (`G`, then a digit): a new child with that choice.
  - **Branch on all candidates** (`B`) on the selected cell.
  - Digit keys add a placement to the selected node; **Erase** removes the node's own manual placements.
  - **Delete branch**, **Apply branch**, **Reset tree**, **Exit search** (the tree is kept).
  - The Manual/Auto toggle shows the cost before auto is enabled.
- **Graph**:
  - an SVG top-down tree; edges point from parent to child;
  - **every inferred value is its own graph node.** A tree node's placements are drawn as a chain under its guess node, in the order they were found: `r3c5=7` (guess) → `r3c6=2` → `r4c1=5` → ….
    - Further guesses and branches hang off the **last** node of their parent's chain.
    - Node kinds look different, and colour is never the only signal:
      - guess: bold, double border;
      - manual placement: solid border;
      - auto placement: dashed border, italic, with the technique, e.g. "Naked Single", in its label and tooltip.
    - Selecting an implication node shows the board **up to and including** that step, with that cell highlighted. Board actions still apply to the owning tree node at its full state, and selection then jumps to the end of its chain.
    - The ✗ is drawn on the node where the contradiction appears: the guess itself, or the placement that caused it.
    - Collapsing a guess node folds its chain and subtree into a `+n` summary.
    - This is presentation only: the persisted `SearchTree` shape is unchanged;
  - **Compact view** is the default; a toolbar toggle switches between Compact and Expanded, and the choice is stored in `localStorage`.
    - Any maximal run of graph nodes where each node has a **unique direct child** is merged into one **chain card**. This includes a guess whose chain continues, and implication steps.
    - The card is a tight vertical list: one row per value, with no arrows between rows. A guess is the bold header row.
    - Every row is still individually selectable, keyboard-navigable and labelled, so each inferred value keeps its own entry.
    - A branch point (2+ children) or a leaf ends the card. Edges are drawn only between cards and plain nodes.
    - Dead rows show the ✗ and the following rows are dimmed. A long card (> 8 rows) shows its first and last 3 rows plus "… n more", which expands on click.
  - **Open in new tab**: the "Open tree in new tab" button opens `/game/:id/tree`, a full-screen graph page.
    - The **game tab is the single writer**: it owns the reducer state and autosave.
    - The tabs sync through a `BroadcastChannel("sudoku-search-<gameId>")`:
      - the game tab broadcasts snapshots (the tree plus UI selection) after every change;
      - the tree tab sends commands: select node or step, collapse/expand, guess, branch, delete branch.
    - The tree tab starts from `GET /games/:id` (the persisted tree), then follows live snapshots.
    - If no game tab answers a ping, the tree tab is a **read-only** view of the saved tree, with a notice and a "refresh" action.
    - Messages are versioned and validated; anything unknown is ignored.
    - The tree tab authenticates with the usual silent refresh, so the token is never sent across tabs.
  - dead nodes get a red ✗ and a dimmed subtree; solved nodes get ✓; the selected node is highlighted;
  - pan and zoom, and subtree collapse.
- **Accessible**: `role="tree"` / `treeitem` with `aria-selected` / `aria-expanded`. Arrow keys move to the parent, child and sibling, and Enter selects. Labels read like "r3c5 equals 7, dead: 7 appears twice in row 3".
- **Logic**:
  - The tree is a pure `searchReducer`.
  - Contradiction checking and candidates are computed client-side, constraint-only, with the same semantics as the validator, for instant feedback in manual mode.
  - Auto mode calls the propagate endpoint.
  - The tree is saved through the existing debounced autosave PATCH.

### 5.6 Import a puzzle from a photo — `vision/` (`sudoku_vision`)

The player drops, pastes or takes a photo of a printed Sudoku. Partly solved puzzles work too: the **printed givens** and the **handwritten entries** are both read.

The player always **reviews and corrects** the result before playing. The game then continues in the normal frontend. Recognition runs **locally on our server**, photos are **never stored**, and imported games are **kept off the public leaderboard**.

#### Pipeline (`sudoku_vision`)
1. **Decode the image.** Check the magic bytes and enforce the size limits (≤ 10 MB, ≤ 40 MP, decompression-bomb safe). Apply EXIF orientation and downscale to ≤ 2000 px on the long side.
2. **Find the grid.** Grayscale and adaptive threshold, then take the largest convex 4-point contour, with a Hough-line fallback. The caller may pass `corners` to override detection, which the review UI uses after the player adjusts them.
3. **Straighten it.** A perspective warp to a square, followed by an optional mild de-curving pass.
4. **Read the cells.** Remove grid lines and border-touching components, then use ink-ratio detection for empty cells.
5. **Classify each non-empty cell.** A small model outputs:
   - the digit 1–9;
   - the **kind**, `given` (printed) or `handwritten`;
   - a confidence and the top-3 alternatives.
6. **Correct using the constraints.** If the givens contradict each other, or have 0 or ≥ 2 solutions, try the top-3 alternatives of the lowest-confidence **given** cells, using the validator's public API (`find_contradiction`, `count_solutions`).
   - The correction is accepted only if the result is consistent and has a unique solution.
   - Every changed cell is flagged `auto_corrected`.
   - Handwritten cells are **never** corrected against the solution, because that would leak it. They are only flagged when they contradict a given.

**Model:**
- **Inference** runs on numpy, opencv-python-headless and onnxruntime. The model is an ONNX file under 2 MB, committed together with a JSON metadata file (training data, accuracy, version). **No pickle.**
- **Training** has its own dependency group (`train`) and is reproducible through `vision/scripts/train.py`. Printed digits are rendered synthetically from open fonts; handwritten digits come from MNIST or EMNIST. Downloads go to a gitignored cache and are verified by checksum, and their licenses are recorded.
- **Tests** use synthetic "phone photos": rendered grids with printed and handwritten digits, perspective, blur, lighting gradients, noise, JPEG artefacts and backgrounds. Labelled real photos go under `vision/tests/photos/` when available.
- **Targets on the synthetic set:**
  - grid found in ≥ 98 % of photos;
  - printed-digit accuracy ≥ 99.5 %;
  - handwritten-digit accuracy ≥ 97 %;
  - given-vs-handwritten classification ≥ 98 %;
  - p95 recognition time < 1.5 s per photo.

**Public API:**
```python
@dataclass(frozen=True)
class CellReading:
    index: int                                  # 0..80
    digit: int                                  # 0 = empty
    kind: Literal["empty", "given", "handwritten"]
    confidence: float                           # 0..1
    alternatives: tuple[tuple[int, float], ...] # top-3 (digit, probability), best first
    auto_corrected: bool

@dataclass(frozen=True)
class Recognition:
    corners: tuple[tuple[float, float], ...]    # TL, TR, BR, BL in (oriented) input-image pixels
    image_size: tuple[int, int]                 # (width, height) of the oriented input image
    cells: tuple[CellReading, ...]              # 81
    grid_confidence: float
    warnings: tuple[str, ...]                   # e.g. "givens have multiple solutions"

class RecognitionError(Exception):
    code: Literal["image_unreadable", "unsupported_image", "image_too_large", "no_grid_found"]

def recognize(image: bytes, *, corners: Sequence[tuple[float, float]] | None = None) -> Recognition
```
`sudoku_vision` depends only on `sudoku_validator`, and only through its public API.

#### Backend
- **`POST /api/v1/imports/recognize`** (auth required): multipart, with field `file` (jpeg, png or webp) and an optional field `corners`, a JSON array of four `[x, y]` pairs.
  - Returns `RecognitionOut`, which has the same fields as `Recognition`; `alternatives` is `[{digit, p}]`.
  - It runs in the existing process pool with a 10 s timeout.
  - Errors:
    - 413 `image_too_large`;
    - 415 `unsupported_image`;
    - 422 `image_unreadable` / `no_grid_found` / `validation_error`;
    - 429 `rate_limited` (`IMPORT_RATE_LIMIT`, default `10/minute`);
    - 503 `recognition_unavailable` (a timeout or a worker failure).
  - The image is processed in memory and never written or logged.
- **`POST /api/v1/imports/check`** with body `{givens, current}` returns `{consistent, contradiction, solution_count, difficulty, rating_score}`.
  - `solution_count` is 0, 1 or 2 (meaning ≥ 2). `difficulty` is null when unrated or invalid.
  - The response **never contains the solution**. This endpoint gives live feedback during review.
- **`POST /api/v1/games/import`** with body `{givens, current}` returns **201 `GameOut`**.
  - `current` must keep the givens (otherwise 422 `givens_modified`). Handwritten entries go into `current`.
  - The givens must be consistent and have exactly one solution. Otherwise it returns 422 `puzzle_inconsistent`, `no_solution` or `multiple_solutions`.
  - The puzzle is rated with `rate()`. If it needs techniques beyond our set, it is stored with `difficulty = null`, shown as "Unrated", with an expert base score and a 45-minute par.
  - It abandons the current in-progress game, as `POST /games` does.
  - If the givens already exist in `puzzles`, that row is reused.
- **DB** (migration `0003`):
  - `puzzles.source` `'generated' | 'imported'`, default `'generated'`;
  - `puzzles.difficulty` becomes nullable (only imported puzzles may be null);
  - imported puzzles never enter the pool.
- **API shape changes:**
  - `GameOut` adds `source: "generated" | "imported"`, and `difficulty` becomes `Difficulty | null`;
  - score history items add `source`.
  - **The leaderboard excludes imported games** (including `/leaderboard/me`). Personal stats and history include them.

**Contract as published** (`backend/openapi.json`):
- **Schemas:** `RecognizeImportForm` (multipart: `file`, optional `corners`), `RecognitionOut`, `CellReadingOut`, `DigitAlternative {digit, p}`, `ImageSize {width, height}`, `ImportBoardIn {givens, current}`, `ImportCheckOut`, and the enum `GameSource`.
- **`corners`** are `[x, y]` pairs in both directions, so the client can send back what it received.
- **Decision: `/imports/check` computes `solution_count` and the rating from the givens only.** Counting the solutions of `current` would reveal whether the handwritten entries are wrong, which would leak the solution. `consistent` and `contradiction` describe `current`, and are constraint-only.
- **Decision:** `/imports/check` has its own `IMPORT_CHECK_RATE_LIMIT` (default `120/minute`), because it runs on every debounced edit.

**Implementation decisions:**
- **`games.source` and `puzzles.source`.** The leaderboard filters on `games.source = 'generated'`. An import may reuse an existing generated puzzle row, so filtering on the puzzle would let someone solve a known puzzle offline, import it, and post a ranked score. `puzzles.source` only keeps imported puzzles out of the pool.
- **Migration 0003's downgrade loses data:** it deletes imported games and puzzles.
- **Rating:** `/imports/check` and `/games/import` rate in the worker pool with `IMPORT_RATING_TIMEOUT_SECONDS` (default 3). On a timeout, or if the puzzle can't be solved logically, the result is "Unrated" (`difficulty = null`). Handwritten entries that contradict the givens are accepted, as on a normal board.
- **Recognition** runs in the worker pool with `RECOGNITION_TIMEOUT_SECONDS` (default 10). `IMPORT_RATE_LIMIT` and the 10 MiB limit are enforced **before and while** the body streams. The photo stays in memory, is never spooled to disk, and is never logged.
- **nginx** needs a dedicated location for `/api/v1/imports/recognize` with `client_max_body_size 11m` and `proxy_request_buffering off`, so photos aren't buffered to disk. The rest of `/api/` keeps 64 KB.

**Review fixes** (reviewer findings, 2026-11-20):
- **Rate limit:** `POST /games/import` is limited by `IMPORT_GAME_RATE_LIMIT` (default `10/minute`) and declares 429.
- **Provisional ratings** (migration 0004):
  - `difficulty` NULL with `rating_score` NULL means **pending**, for example after a rating timeout. The next import of the same givens re-rates it and updates the row.
  - `difficulty` NULL with a non-NULL `rating_score` means **genuinely Unrated**, which is final.
- **Pool and fallback:** when an import reuses a pooled generated puzzle, the pool row is deleted. `create_game` also refuses (503) any reused row that has an imported game, which covers the generator's synchronous fallback too.
- **Memory:**
  - the worker converts vision results to plain backend dataclasses, so the API process never loads cv2, onnxruntime or PIL;
  - `sudoku_vision` imports lazily;
  - decoding uses per-format pixel caps and 8-bit conversion, under a memory-budget test.

#### Frontend
- **Entry points:** "Import from photo" on the home and new-game screens.
  - Supports drag and drop, a file picker, paste from the clipboard, and "Take photo" (`capture="environment"`) on mobile.
- **Client-side preprocessing:** apply EXIF orientation (`createImageBitmap(..., {imageOrientation: "from-image"})`), downscale to ≤ 2000 px and re-encode as JPEG. This **removes EXIF metadata such as GPS** before upload. Then upload with progress shown.
- **Review screen:**
  - The photo with the detected grid outline. The four corners can be dragged, and "Re-detect" re-runs recognition with those `corners`.
  - An editable 9×9 grid next to it:
    - each cell shows its digit and its kind (given or handwritten, styled distinctly, never by colour alone);
    - low-confidence cells (< 0.8) and auto-corrected cells are highlighted, with their alternatives one click away;
    - the keyboard works as on the board, plus a key that toggles given/handwritten.
  - Live validation via `/imports/check`, debounced: the contradiction is shown on the board, plus the solution count and the rated difficulty.
  - "Start game" is enabled only for a consistent, uniquely solvable puzzle. Starting calls `/games/import` and navigates to `/game/:id`.
- **Imported games** show an "Imported" badge, and difficulty "Unrated" when it's null. The leaderboard explains that imported games aren't ranked.
- **Accessibility:** everything is keyboard-operable. Corner handles have arrow-key nudging and labels.

## 6. Agents and ownership

Agents are defined in `.claude/agents/`. Who may change which files is defined **in one place**, `.claude/ownership.toml`, and checked by `scripts/check_ownership.py`. Project-wide rules, commands and the report format are in `CLAUDE.md`, and each area keeps handoff notes in its `AGENTS.md`.

| Agent | Owns | Depends on | Notes file |
|---|---|---|---|
| `sudoku-validator` | `validator/`, `uv.lock` (shared) | — | `validator/AGENTS.md` |
| `sudoku-generator` | `generator/`, `uv.lock` (shared) | validator public API | `generator/AGENTS.md` |
| `sudoku-api` | `backend/` (except container files), `.env.example`, `uv.lock` | generator, validator and vision public APIs | `backend/AGENTS.md` |
| `sudoku-frontend` | `frontend/` (except container files) | `backend/openapi.json` | `frontend/AGENTS.md` |
| `sudoku-vision` | `vision/`, `uv.lock` (shared) | validator public API | `vision/AGENTS.md` |
| `sudoku-docker` | Dockerfiles, entrypoint, `nginx.conf`, compose files, `.dockerignore`, `docker/`, CI docker job, Docker section of `.env.example` | everything (read-only) | `docker/AGENTS.md` |
| `sudoku-reviewer` | nothing (read-only) | — | — |

The orchestrator (the main session) owns everything no agent owns: PLAN.md, CLAUDE.md, the agent definitions, `scripts/`, CI and the README. It also shares `ci.yml`, `.env.example`, `uv.lock` and the `*/AGENTS.md` notes.

**Process** (details in CLAUDE.md):
1. **Contract first:** PLAN.md §5 and `backend/openapi.json`. For an HTTP change, the backend publishes the schema, the frontend runs `gen:api`, and then both build in parallel.
2. **One fresh agent per feature,** which starts from its `AGENTS.md`. Resume an agent only for short follow-ups.
3. **After each agent:**
   - `check_ownership.py <agent>`;
   - `./scripts/verify.sh --only <areas>`, with `--full` for cross-boundary work.
4. **Before each commit,** `sudoku-reviewer` reviews the diff.
5. **CI** runs the same checks. It also checks that the generated API types aren't stale. A nightly job runs `verify.sh --full --repeat 5` to catch flaky tests.

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
