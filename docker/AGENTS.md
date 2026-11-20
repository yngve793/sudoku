# Docker: agent notes (owner: sudoku-docker)

**Files:**
- `docker-compose.yml` (prod-like) and `compose.dev.yml` (hot-reload override);
- `backend/Dockerfile`, `backend/Dockerfile.dockerignore`, `backend/docker-entrypoint.sh`;
- `frontend/Dockerfile`, `frontend/nginx.conf`, `frontend/.dockerignore`;
- `docker/smoke-test.sh`;
- the CI `docker` job.

## Topology
- **Services:**
  - `postgres` 18.7: published on `127.0.0.1:${POSTGRES_PORT:-5432}` through the `dbhost` network;
  - `mailpit` 1.34: UI on `127.0.0.1:${MAILPIT_PORT:-8025}`;
  - `migrate`: a one-shot run before the api;
  - `api`: `RUN_MIGRATIONS=false`, not published, **single replica**;
  - `frontend`: nginx-unprivileged on **8080**, published as `${APP_PORT:-8080}`;
  - `seed`: profile `tools`.
- **Networks:**
  - `backend` is internal;
  - `edge` is fixed at `${EDGE_SUBNET:-10.89.28.0/24}`. The same variable feeds the api's `FORWARDED_ALLOW_IPS`, so never hard-code one without the other;
  - `mail` and `dbhost` exist only for publishing ports.
- **Same origin is required:** nginx proxies `/api/` to the api because the refresh cookie is `SameSite=strict` with `Path=/api/v1/auth`.

## API image (photo import, PLAN.md §5.6)
- The api depends on `validator`, `generator` **and `vision`**. Every workspace member's `pyproject.toml` goes in the dependency layer, and its `src/` in the source layer. The allow-list in `backend/Dockerfile.dockerignore` must name each one too.
- **Model:** `vision/src/sudoku_vision/models/` (`digits.onnx` + `digits.json`) comes along with `COPY vision/src`. Hatchling `artifacts` ships it into site-packages under `--no-editable`. Check: `sudoku_vision/models` is in the venv, and the smoke test's recognize step returns 81 cells.
- **No apt packages needed:** opencv-python-headless 5.1 and onnxruntime 1.32 import fine on `python:3.13-slim-trixie`. Add apt packages only if an import fails.
- **`train` group (torch, onnx):** it isn't a default group, so `--no-dev` already leaves it out. Check with `importlib.util.find_spec('torch') is None`.
- **Size:** 243 MB before vision, 490 MB with it (onnxruntime 63M, opencv 90M, numpy 64M).
- **Harmless warning:** onnxruntime logs "Failed to persist telemetry device ID" because `$HOME` is read-only.
- **Dev override:** it bind-mounts `vision/src` as well, and adds it to `PYTHONPATH` and `--reload-dir`.

## nginx
- `/api/` keeps `client_max_body_size 64k`.
- `location = /api/v1/imports/recognize` copies the `/api/` proxy settings, plus:
  - `client_max_body_size 11m` (10 MiB image + multipart overhead);
  - `proxy_request_buffering off`, so photos are never written to nginx's disk. The API enforces the exact limit while streaming.
- **Proxy settings:** a change to the proxy settings of `/api/` must be made in **both** locations.
- **nginx's own 413** goes through `error_page 413 @image_too_large`, which returns a JSON `ErrorOut` (`code: image_too_large`).
- Check: `docker run --rm --add-host api:127.0.0.1 --entrypoint nginx <frontend image> -t`.

## Smoke test (`docker/smoke-test.sh`)
- After hints and autosave: `/imports/check` and then `/games/import`, both with the extreme game's givens. The import abandons that game.
- Then `/imports/recognize` through nginx:
  - 1 MiB of non-image bytes → the API's 415 JSON (this proves the 11m location);
  - `vision/tests/fixtures/synth_7_00.jpg` → 200 with 81 cells (required; a missing fixture fails the test);
  - 12 MB → 413 JSON from nginx.
- The recognize limit is `IMPORT_RATE_LIMIT` (10/minute) and the test uses 3 requests, so keep any new recognize steps under that.

## Pitfalls
- **Subnets:** the subnet must stay outside Docker's default pools (172.17–31.x, 192.168.x), or networks fail at random with "Pool overlaps".
- **Internal networks can't publish ports.** A service that needs a host port also needs a non-internal network.
- **`.env` values:** compose ignores `.env`'s `DATABASE_URL`, `CORS_ORIGINS`, `FRONTEND_URL` and `SMTP_*`, which are for the non-Docker setup. `APP_URL` drives the links and CORS.
- **Hardening applies to everything:** `no-new-privileges`, `cap_drop: ALL` (Postgres adds back a few), `read_only` + `tmpfs`, limits, log rotation, `init: true` on the api.
- **Isolated second instance:** these knobs exist so a second project (e.g. `-p sudoku-verify`) can run next to the user's `sudoku` stack. The defaults equal the old hard-coded values.
  - `API_IMAGE` (`sudoku-api:local`), `FRONTEND_IMAGE` (`sudoku-frontend:local`), `FRONTEND_DEV_IMAGE` (`sudoku-frontend:dev`);
  - `APP_PORT` (8080), `MAILPIT_PORT` (8025), `POSTGRES_PORT` (5432);
  - `EDGE_SUBNET` (`10.89.28.0/24`);
  - `APP_URL` defaults to `http://localhost:${APP_PORT}` through nested interpolation, so `APP_PORT` alone is enough. `.env.example` keeps `APP_URL` commented out for that reason.
  - **Pitfall:** `up --build` with a different `-p` but the same image tags *retags the user's images*. Their next `up` then silently runs the verify build. Always override both image tags.
  - Shell env beats `--env-file`. `.env.example` sets the defaults explicitly, so exported overrides still win.
  - Verified on 2026-11-19 with `APP_PORT=18080 MAILPIT_PORT=18025 POSTGRES_PORT=15432 EDGE_SUBNET=10.89.29.0/24` and `:verify` tags, while the user's stack kept running. Its container and image IDs were unchanged.
  - The dev override's ports 8000 and 5173 are still fixed, so only one dev stack can run at a time.
- **Never** `down -v` the user's `sudoku` project.

## Verify
- `./scripts/verify.sh --docker`
- `docker compose config -q` for prod, prod + dev, and `--profile tools`
