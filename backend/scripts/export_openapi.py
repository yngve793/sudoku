"""Write the API's OpenAPI schema to backend/openapi.json for the frontend client.

Usage (from the repo root):  uv run python backend/scripts/export_openapi.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from sudoku_api.openapi_export import render_openapi

OUTPUT = Path(__file__).resolve().parents[1] / "openapi.json"


def main() -> int:
    OUTPUT.write_text(render_openapi(), encoding="utf-8")
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
