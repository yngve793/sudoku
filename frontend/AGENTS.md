# frontend/: agent notes

**Stack:** React 19, TypeScript (strict, `noUncheckedIndexedAccess`), Vite, TanStack Query, React Router 7, MSW 2, Vitest, Playwright. TypeScript stays on 5.9 because of typescript-eslint and openapi-typescript peer dependencies, and ESLint on 9 because of jsx-a11y.

## Contract

- **API types** come only from `npm run gen:api` (`src/api/schema.gen.ts`, re-exported by `src/api/types.ts`). Never hand-write duplicates; CI fails if the generated file is stale.
- **Mocks** (`src/mocks/`) must mirror the real backend, including its validation and error codes. `src/mocks/contract.test.ts` validates them against `backend/openapi.json`.
- **Constraint checks:** `src/features/search/constraints.ts` must match the validator. A parity test runs against `validator/tests/fixtures/contradictions.json`.

## Conventions and pitfalls

- **Game logic** is pure reducers: `features/game/gameReducer.ts` and `features/search/searchReducer.ts`. Components stay thin.
- **Auth:**
  - the access token lives in memory only; refresh uses the httpOnly cookie (`credentials: "include"`);
  - only a 401 from `/auth/refresh` logs the user out.
- **Autosave:**
  - `useAutosave.ts` and the pure `saveQueue.ts`;
  - keepalive saves, a single unload flush, and "changed since last _sent_" logic;
  - a 409 refetches. Don't add more unload handlers that send.
  - Debug with `localStorage['sudoku.debug.autosave']='1'`.
- **Search mode:**
  - one graph node per inferred value; compact chain cards are the default;
  - a technique is shown only for the current session, because the persisted tree stores no technique;
  - the client strips UI-only fields before saving (the backend rejects unknown keys).
- **Tree tab** (`/game/:id/tree`):
  - synced via `BroadcastChannel("sudoku-search-<id>")`, and the **game tab is the only writer**;
  - messages are versioned and validated, with no echo;
  - the `hello` timeout is injectable (`syncTimers`).
- **Tests:**
  - no sleeps or wall-clock thresholds in `npm test`;
  - timing checks go in `*.perf.test.tsx`, run with `npm run test:perf` and `VITE_PERF=true`;
  - use fake or injectable timers.
- **E2E specs:**
  - `e2e/*.spec.ts` run in mocked mode;
  - the `real-backend*.spec.ts` specs run only with `E2E_BASE_URL` and `E2E_EMAIL_LOG` set; `verify.sh --full` sets them up.
- **Mock DB:** kept in `localStorage`, so two-tab tests share it. Bump its storage key when the shape changes.
- **Vite dev proxy target:** `VITE_API_PROXY_TARGET`, default `http://localhost:8000`.
- **Container files** (Dockerfile, nginx.conf, .dockerignore) belong to `sudoku-docker`.

## Verify

`./scripts/verify.sh --only frontend --e2e`, and add `--full` for auth, autosave, search sync or API changes.
