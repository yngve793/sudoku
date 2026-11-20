# syntax=docker/dockerfile:1.7
#
# Sudoku API image. Build context MUST be the repository root (the backend depends on the
# validator, generator and vision workspace packages):
#
#   docker build -f backend/Dockerfile -t sudoku-api .
#
# backend/Dockerfile.dockerignore is applied automatically by BuildKit for this Dockerfile.

ARG PYTHON_VERSION=3.13
ARG UV_VERSION=0.13.9

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# --- build stage: resolve and install into /app/.venv --------------------------------------
FROM python:${PYTHON_VERSION}-slim-trixie AS builder

COPY --from=uv /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /src

# 1) Third-party dependencies only (cached until the lockfile or a pyproject changes).
#    --no-dev drops the `dev` group; vision's `train` group (torch, onnx) is not a default
#    group, so it is never installed either. Runtime deps include opencv-python-headless and
#    onnxruntime, whose manylinux wheels need no extra apt packages on slim-trixie.
COPY pyproject.toml uv.lock ./
COPY validator/pyproject.toml validator/pyproject.toml
COPY generator/pyproject.toml generator/pyproject.toml
COPY vision/pyproject.toml vision/pyproject.toml
COPY backend/pyproject.toml backend/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package sudoku-api --extra postgres \
        --no-install-workspace

# 2) The workspace packages themselves, installed non-editable so the runtime image only
#    needs the virtualenv.
COPY validator/src validator/src
COPY generator/src generator/src
# Includes src/sudoku_vision/models/ (ONNX model + metadata) when present. Hatchling ships it
# via `artifacts`, so it lands in site-packages even with --no-editable. The folder may be
# missing or empty: COPY of the parent directory works either way.
COPY vision/src vision/src
COPY backend/src backend/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package sudoku-api --extra postgres --no-editable

# --- runtime stage --------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim-trixie AS runtime

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --no-create-home app \
    && mkdir -p /app/data \
    && chown app:app /app/data

WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
COPY backend/alembic.ini /app/alembic.ini
COPY backend/alembic /app/alembic
COPY --chmod=0755 backend/docker-entrypoint.sh /app/docker-entrypoint.sh

USER app

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request as u; u.urlopen('http://127.0.0.1:' + os.getenv('PORT', '8000') + '/api/v1/health', timeout=4)"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
