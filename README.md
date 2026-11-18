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
cp .env.example .env            # set JWT_SECRET to a long random string
docker compose up --build
```

- App: <http://localhost:8080>
- Mailpit (catches verification and password-reset emails): <http://localhost:8025>

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

Each component has its own sub-agent in [.claude/agents/](.claude/agents/): `sudoku-validator`, `sudoku-generator`, `sudoku-api` and `sudoku-frontend`. Each agent owns exactly one folder. Changes to an API contract go through PLAN.md.
