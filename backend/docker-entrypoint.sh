#!/bin/sh
# Container entrypoint: migrate, then serve.
#
# Env:
#   PORT                (default 8000)
#   RUN_MIGRATIONS      set to "false" to skip `alembic upgrade head` (default true)
#   FORWARDED_ALLOW_IPS IPs/CIDRs of the reverse proxy whose X-Forwarded-* headers are trusted
#                       (default 127.0.0.1). Set it to the frontend proxy's address/subnet,
#                       otherwise every client shares the proxy's IP for rate limiting.
#   Any extra arguments are passed through to uvicorn.
set -eu

cd /app

if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
    echo "running database migrations"
    alembic -c /app/alembic.ini upgrade head
fi

exec uvicorn sudoku_api.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-8000}" \
    --proxy-headers \
    --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" \
    --no-server-header \
    "$@"
