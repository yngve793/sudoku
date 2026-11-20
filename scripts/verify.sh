#!/usr/bin/env bash
# Single verification entry point for humans, agents and CI.
#
#   ./scripts/verify.sh                      # fast: lint/format/types/unit tests/build + contract drift
#   ./scripts/verify.sh --e2e                # + Playwright against the mocked API
#   ./scripts/verify.sh --full               # + Playwright against a real backend (isolated ports/DB)
#   ./scripts/verify.sh --docker             # + build and smoke-test an isolated compose project
#   ./scripts/verify.sh --only backend,frontend
#   ./scripts/verify.sh --repeat 5           # run unit tests 5x (flaky-test hunt)
#
# Never writes tracked files: drift checks generate into a temp dir and compare.
# Isolation: --full uses API_PORT (8765) / WEB_PORT (5765); the mocked e2e uses 5174;
# --docker runs project `sudoku-verify` with its own image tags, ports and subnet, so it can
# run while the user's `sudoku` stack is up. Busy ports fail fast instead of being reused.
# On failure, server logs are copied to .verify-logs/.
set -euo pipefail
cd "$(dirname "$0")/.."

ONLY="validator,generator,vision,backend,frontend"
E2E=0 FULL=0 DOCKER=0 REPEAT=1
need_arg() { [[ $# -ge 2 && -n "$2" ]] || { echo "$1 needs a value" >&2; exit 2; }; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) need_arg "$@"; ONLY="$2"; shift 2 ;;
    --e2e) E2E=1; shift ;;
    --full) E2E=1; FULL=1; shift ;;
    --docker) DOCKER=1; shift ;;
    --repeat) need_arg "$@"; REPEAT="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$REPEAT" =~ ^[1-9][0-9]*$ ]] || { echo "--repeat must be an integer >= 1" >&2; exit 2; }
for area in ${ONLY//,/ }; do
  case "$area" in validator|generator|vision|backend|frontend) ;;
    *) echo "unknown area in --only: $area" >&2; exit 2 ;; esac
done
has() { [[ ",$ONLY," == *",$1,"* ]]; }

FAILED=()
step() { printf '\n\033[1m=== %s\033[0m\n' "$*"; }
run() { # run <label> <cmd...>; record failure but keep going
  local label=$1; shift
  if "$@"; then echo "ok: $label"; else echo "FAILED: $label"; FAILED+=("$label"); fi
}
port_busy() { # port_busy <port>  (IPv4 or IPv6 listener)
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/localhost/$1") 2>/dev/null
  fi
}
require_free() { # require_free <label> <port>...
  local label=$1; shift
  for p in "$@"; do
    if port_busy "$p"; then
      echo "FAILED: $label: port $p is already in use (another verify run or dev server?)"
      FAILED+=("$label (port $p busy)"); return 1
    fi
  done
}
ensure_node_modules() { [[ -d frontend/node_modules ]] || (cd frontend && npm ci --no-audit --no-fund); }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/sudoku-verify.XXXXXX")
PIDS=()
cleanup() {
  local p i
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  # Wait for graceful shutdown (uvicorn + its worker pool) so ports are free when we exit.
  for p in "${PIDS[@]:-}"; do
    [[ -n "$p" ]] || continue
    for ((i = 0; i < 100; i++)); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$p" 2>/dev/null || true
  done
  if ((${#FAILED[@]})) && compgen -G "$WORK/*.log" >/dev/null; then
    mkdir -p .verify-logs && cp "$WORK"/*.log .verify-logs/ && echo "logs kept in .verify-logs/"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------- Python packages
for pkg in validator generator vision backend; do
  has "$pkg" || continue
  step "$pkg"
  run "$pkg ruff" uv run ruff check "$pkg"
  run "$pkg format" uv run ruff format --check "$pkg"
  run "$pkg mypy" uv run mypy "$pkg/src"
  for ((i = 1; i <= REPEAT; i++)); do
    run "$pkg pytest #$i" bash -c "cd '$pkg' && uv run pytest -m 'not slow' -q"
  done
done

# ---------------------------------------------------------------- Contract drift (read-only)
# Each side only checks its own generated artifact against its own input:
#   backend : backend/openapi.json      == render_openapi() of the current backend code
#   frontend: src/api/schema.gen.ts     == openapi-typescript(backend/openapi.json)
if has backend; then
  step "contract drift (backend)"
  if uv run python -c 'import sys; from sudoku_api.openapi_export import render_openapi; sys.stdout.write(render_openapi())' \
    >"$WORK/openapi.json" 2>"$WORK/openapi-export.log" && cmp -s "$WORK/openapi.json" backend/openapi.json; then
    echo "ok: backend/openapi.json matches the code"
  else
    echo "FAILED: backend/openapi.json is stale (run: uv run python backend/scripts/export_openapi.py)"
    FAILED+=("openapi.json drift")
  fi
fi
if has frontend; then
  step "contract drift (frontend)"
  ensure_node_modules
  if (cd frontend && npx --no-install openapi-typescript ../backend/openapi.json -o "$WORK/schema.gen.ts" \
    >"$WORK/gen-api.log" 2>&1) && cmp -s "$WORK/schema.gen.ts" frontend/src/api/schema.gen.ts; then
    echo "ok: src/api/schema.gen.ts matches backend/openapi.json"
  else
    echo "FAILED: frontend/src/api/schema.gen.ts is stale (run: cd frontend && npm run gen:api)"
    FAILED+=("schema.gen.ts drift")
  fi
fi

# ---------------------------------------------------------------- Frontend
if has frontend; then
  step "frontend"
  ensure_node_modules
  run "frontend format" bash -c "cd frontend && npm run -s format:check"
  run "frontend lint" bash -c "cd frontend && npm run -s lint"
  run "frontend typecheck" bash -c "cd frontend && npm run -s typecheck"
  for ((i = 1; i <= REPEAT; i++)); do
    run "frontend test #$i" bash -c "cd frontend && npm test --silent"
  done
  run "frontend build" bash -c "cd frontend && npm run -s build >/dev/null"
  if ((E2E)) && require_free "frontend e2e (mocked)" 5174; then
    # --retries=0: a flaky test must fail here, not pass on retry.
    run "frontend e2e (mocked)" bash -c "cd frontend && npx playwright test --retries=0"
  fi
fi

# ---------------------------------------------------------------- Real-backend e2e
wait_for() { # wait_for <url> <seconds>
  local i
  for ((i = 0; i < $2; i++)); do curl -fs "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
alive() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null || return 1; done; }

if ((FULL)) && { has backend || has frontend; }; then
  step "e2e against a real backend"
  API_PORT=${API_PORT:-8765} WEB_PORT=${WEB_PORT:-5765}
  if require_free "real-backend e2e" "$API_PORT" "$WEB_PORT"; then
    ensure_node_modules
    export DATABASE_URL="sqlite:///$WORK/e2e.db"
    export JWT_SECRET="verify-only-secret-0123456789abcdef0123456789"
    export EMAIL_BACKEND=console RATE_LIMIT_ENABLED=false COOKIE_SECURE=false
    export CORS_ORIGINS="http://localhost:$WEB_PORT" FRONTEND_URL="http://localhost:$WEB_PORT"
    export POOL_TARGET_PER_LEVEL=3 LOG_JSON=false
    if uv run alembic -c backend/alembic.ini upgrade head >"$WORK/migrate.log" 2>&1; then
      uv run uvicorn sudoku_api.main:app --port "$API_PORT" >"$WORK/api.log" 2>&1 &
      API_PID=$!
      PIDS+=("$API_PID")
      # `exec` so $! is vite itself, not a subshell (killing a subshell orphans vite).
      (cd frontend && VITE_API_PROXY_TARGET="http://127.0.0.1:$API_PORT" \
        exec ./node_modules/.bin/vite --port "$WEB_PORT" --strictPort >"$WORK/web.log" 2>&1) &
      WEB_PID=$!
      PIDS+=("$WEB_PID")
      if wait_for "http://127.0.0.1:$API_PORT/api/v1/health" 60 &&
        wait_for "http://localhost:$WEB_PORT" 60 && alive "$API_PID" "$WEB_PID"; then
        run "frontend e2e (real backend)" bash -c "cd frontend && \
          E2E_BASE_URL=http://localhost:$WEB_PORT E2E_EMAIL_LOG=$WORK/api.log \
          npx playwright test real-backend --project=chromium --retries=0"
        if grep -qE '" 5[0-9][0-9]' "$WORK/api.log"; then
          echo "FAILED: API log contains 5xx responses"; FAILED+=("api 5xx")
          grep -E '" 5[0-9][0-9]' "$WORK/api.log" | head -5
        fi
      else
        echo "FAILED: our servers did not start (or died)"; tail -20 "$WORK/api.log" "$WORK/web.log"
        FAILED+=("real-backend servers")
      fi
    else
      echo "FAILED: migrations"; cat "$WORK/migrate.log"; FAILED+=("migrations")
    fi
  fi
fi

# ---------------------------------------------------------------- Docker smoke test (isolated)
if ((DOCKER)); then
  step "docker compose smoke test (project sudoku-verify)"
  V_APP_PORT=${VERIFY_APP_PORT:-18080} V_MAIL_PORT=${VERIFY_MAILPIT_PORT:-18025}
  V_PG_PORT=${VERIFY_POSTGRES_PORT:-15432} V_SUBNET=${VERIFY_EDGE_SUBNET:-10.89.29.0/24}
  if ! docker info >/dev/null 2>&1; then
    echo "FAILED: docker is not running"; FAILED+=("docker")
  elif require_free "docker smoke test" "$V_APP_PORT" "$V_MAIL_PORT" "$V_PG_PORT"; then
    ENVF="$WORK/verify.env"
    sed 's/^JWT_SECRET=.*/JWT_SECRET=verify-only-secret-0123456789abcdef0123456789/' .env.example >"$ENVF"
    cat >>"$ENVF" <<EOF
API_IMAGE=sudoku-api:verify
FRONTEND_IMAGE=sudoku-frontend:verify
APP_PORT=$V_APP_PORT
APP_URL=http://localhost:$V_APP_PORT
MAILPIT_PORT=$V_MAIL_PORT
POSTGRES_PORT=$V_PG_PORT
EDGE_SUBNET=$V_SUBNET
EOF
    DC=(docker compose --env-file "$ENVF" -p sudoku-verify)
    if "${DC[@]}" up --build -d --wait --wait-timeout 300 >"$WORK/compose-up.log" 2>&1; then
      run "docker smoke test" env APP_URL="http://localhost:$V_APP_PORT" \
        MAILPIT_URL="http://localhost:$V_MAIL_PORT" ./docker/smoke-test.sh
    else
      echo "FAILED: compose up"; tail -30 "$WORK/compose-up.log"; FAILED+=("docker up")
    fi
    "${DC[@]}" logs --no-color >"$WORK/compose.log" 2>&1 || true
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    docker image rm sudoku-api:verify sudoku-frontend:verify >/dev/null 2>&1 || true
  fi
fi

# ---------------------------------------------------------------- Summary
step "summary"
if ((${#FAILED[@]})); then
  printf 'FAILED (%d):\n' "${#FAILED[@]}"; printf '  - %s\n' "${FAILED[@]}"
  exit 1
fi
echo "ALL CHECKS PASSED"
