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
  - the `real-backend*.spec.ts` specs run only with `E2E_BASE_URL` and `E2E_EMAIL_LOG` set; `verify.sh --full` sets them up;
  - `real-backend-import.spec.ts` uploads `vision/tests/fixtures/synth_7_00.jpg` through the real UI and asserts an exact match with its `.json` labels (don't loosen it; report differences to vision).
- **Mock DB:** kept in `localStorage` (key `v5`), so two-tab tests share it. Bump its storage key when the shape changes.
- **Vite dev proxy target:** `VITE_API_PROXY_TARGET`, default `http://localhost:8000`.
- **Photo import** (`features/import/`, PLAN.md §5.6):
  - routes `/import` → `/import/review` under `ImportFlow`, which holds the photo + recognition in React state only (never storage; reload = start over);
  - `preprocess.ts` re-encodes via canvas (EXIF/GPS stripped, ≤ 2000 px); jsdom has no canvas, so component tests `vi.mock('./preprocess')` and the e2e checks the real thing (`import.spec.ts` imports the module from the dev server); `preprocess.test.ts` stubs `createImageBitmap` + canvas to unit-test the size limits;
  - size limits: the server's 10 MB applies to the **re-encoded** blob (`MAX_UPLOAD_BYTES`, checked after encoding); the original only has a 50 MB decode-safety cap (`MAX_SOURCE_BYTES`), so big 48–50 MP phone photos are accepted;
  - corner editor frame: never add `max-height` to `.photo-editor__frame` (it overrides `aspect-ratio` and squashes the `object-fit: fill` image); the 75vh cap is a width cap from `photoFrameStyle()` in `geometry.ts`. Image, SVG and handles must share that one box. Screenshots: `SHOTS_DIR=/tmp/sudoku-shots npx playwright test -g "tall portrait"`;
  - upload uses XHR (`uploadForm` in `api/client.ts`) for progress; it rejects at once on abort;
  - review state is the pure `reviewReducer.ts` (digit + kind per cell); corner math in `geometry.ts` (corners are in pixels of the uploaded image = `image_size`);
  - Start game (`/games/import`) 429 `rate_limited` shows a retryable message (`startErrorMessage`); review state stays, button re-enabled;
  - live check: `useImportCheck` (debounced, retries 429); Start needs a fresh result with `solution_count === 1` (valid givens); a handwritten-only conflict (`consistent: false`) just shows a warning, as `/games/import` accepts it. Tune timings via `importTimings` in tests;
  - the client never solves: mock-only solver in `mocks/solver.ts`; mock recognition in `mocks/imports.ts` (misread handwritten r1c3, auto-corrected r1c5); force errors with `simulateImportError('recognize'|'check'|'import', …)` (reset after each test; `ImportFlow.test.tsx` does it in `afterEach`) or `localStorage['sudoku.mock.importError.<endpoint>']`.
- **Nullable difficulty:** imported games may have `difficulty: null`; use `difficultyLabel()` / `<GameBadges>` (shows "Unrated" and "Imported"), never index `DIFFICULTY_INFO` with a game's difficulty.
- **Container files** (Dockerfile, nginx.conf, .dockerignore) belong to `sudoku-docker`.

## Verify

`./scripts/verify.sh --only frontend --e2e`, and add `--full` for auth, autosave, search sync or API changes.
