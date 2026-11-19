#!/usr/bin/env bash
# Deprecated: kept for muscle memory. Use ./scripts/verify.sh (see --help).
# Accepts the old space-separated package list: check.sh validator generator
set -euo pipefail
areas=$(IFS=,; echo "${*:-validator,generator,backend}")
exec "$(dirname "$0")/verify.sh" --only "$areas"
