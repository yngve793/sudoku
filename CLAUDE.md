# Sudoku: project instructions

A React + Python Sudoku game. Design and contracts: [PLAN.md](PLAN.md). Human docs: [README.md](README.md).

## Layout and dependency direction

```
validator/ (sudoku_validator, stdlib only) ← generator/ ─┐
                                          ← vision/ ────┴← backend/ (FastAPI) ←HTTP← frontend/ (React)
```

- `validator` never imports `generator` or `vision`; it is the independent judge of generated and recognised puzzles.
- `vision` (photo recognition) uses OpenCV and onnxruntime. Its training dependencies live in a separate group: `uv run --package sudoku-vision --group train ...`.
- Each folder's agent notes live in `<folder>/AGENTS.md` (Docker: `docker/AGENTS.md`). Read the relevant one before changing code there.

## Commands

| What | Command |
|---|---|
| Verify everything (fast) | `./scripts/verify.sh` |
| Verify one area | `./scripts/verify.sh --only backend` (or `validator,generator,vision,backend,frontend`) |
| + mocked e2e / real-backend e2e | `--e2e` / `--full` (isolated ports 8765/5765 and a temp DB) |
| + compose smoke test | `--docker` (isolated project `sudoku-verify` on 18080/18025/15432; safe while your stack runs) |
| Flaky-test hunt | `--repeat 5` |
| Ownership check | `uv run python scripts/check_ownership.py <agent>[,<agent>]` |
| Regenerate API contract | `uv run python backend/scripts/export_openapi.py`, then `cd frontend && npm run gen:api` |

**Quirks:**
- Python is a uv workspace on 3.13.
- Run pytest **per package** (`cd backend && uv run pytest`): each package has its own `tests` package, so a single run from the repo root fails.
- Slow generator tests: `cd generator && uv run pytest --run-slow`.

## Rules for every session and agent

1. **Ownership.** `.claude/ownership.toml` defines who may change which files.
   - Agents edit only their own area.
   - A change needed elsewhere goes into the report under "Requests".
   - The orchestrator runs `check_ownership.py` after every agent run.
2. **Contract first.** Any change to an interface is agreed and written down *before* both sides are implemented:
   - HTTP: `backend/openapi.json`;
   - validator and generator public APIs, and the `SearchTree` shape: PLAN.md §5.
   - The order for an HTTP change:
     1. the backend publishes the schema (`openapi.json`);
     2. the frontend runs `npm run gen:api`;
     3. both sides implement in parallel.
   - Never hand-write types that duplicate the OpenAPI schema.
3. **Verify, don't assume.**
   - A task is done only when `./scripts/verify.sh --only <your areas>` passes.
   - Add `--full` when you change auth, saving, or anything that crosses the HTTP boundary.
   - Report the exact commands and results, including failures and anything you could not run.
4. **Never commit, push, or touch `.env`.**
   - The orchestrator commits after review.
   - `.claude/settings.json` asks before every commit and push, and denies the Read and Edit tools on `.env` and the obvious shell reads of it.
   - Shell access isn't fully blockable, so the rule itself still applies. Never print secrets.
5. **No global installs:** no `brew`, `apt`, `pip install`, or `npm -g`. Add project dependencies through the package manager:
   - Python: `uv add --package <pkg>`;
   - frontend: `npm i -D` inside `frontend/`.
   - `uv.lock` is shared by the Python agents. Two agents must not change it at the same time.
6. **Shared resources:**
   - Dev servers you start must use non-default ports (not 8000/5173/8080) and a temp DB under `$TMPDIR`.
   - Stop them and delete temp data when done.
   - Never `up`, `down`, rebuild or retag the user's `sudoku` compose project; it is often running.
   - Docker verification uses the isolated `sudoku-verify` project through `./scripts/verify.sh --docker`.
   - `verify.sh` fails fast on a busy port rather than reusing someone else's server. If that happens, find the cause; don't kill servers you didn't start.
7. **Decisions:** record non-obvious choices (thresholds, costs, trade-offs) in your report under "Decisions". The orchestrator records them in PLAN.md.

## Report format (agents → orchestrator)

```
## Summary            one paragraph: what changed and whether it is done
## Contract changes   APIs/endpoints/schemas changed, or "none"
## Decisions          non-obvious choices and why
## Files              changed/added files
## Verification       exact commands run + results (and what was NOT verified)
## Open issues        known problems, flakiness, follow-ups
## Requests           changes needed in areas you don't own (owner + exact change)
```

## Orchestrator workflow

1. Write or update the contract (PLAN.md and/or `openapi.json` via the backend agent).
2. Dispatch agents. Use a fresh agent per feature (it starts from its `AGENTS.md`), and resume only for short follow-ups on the same task.
3. After each agent:
   - run `check_ownership.py <agent>`;
   - run `./scripts/verify.sh --only <areas>`, and add `--full` for cross-boundary work.
4. Before committing, have `sudoku-reviewer` review the diff (give it the diff, not the agent's summary).
5. Commit only on the user's request.
