#!/usr/bin/env bash
# Run lint, type-check and tests for every Python package separately.
# (Each package has its own `tests` package, so pytest must run per package.)
set -euo pipefail
cd "$(dirname "$0")/.."
packages=("${@:-validator generator backend}")
for pkg in ${packages[@]}; do
  echo "=== $pkg ==="
  uv run ruff check "$pkg"
  uv run ruff format --check "$pkg"
  uv run mypy "$pkg/src"
  (cd "$pkg" && uv run pytest -m "not slow" -q)
done
