#!/usr/bin/env python3
"""Fail if the working tree contains changes outside the given agents' ownership.

Usage:
    uv run python scripts/check_ownership.py sudoku-frontend
    uv run python scripts/check_ownership.py sudoku-api,sudoku-validator   # parallel run
    uv run python scripts/check_ownership.py sudoku-api --base HEAD~1      # committed changes

Without --base it checks uncommitted changes (staged, unstaged, untracked and deleted), which
is exactly what an agent touched when the tree was clean before it started. Renames count as
a deletion of the old path plus an addition of the new one; both must be owned.

`orchestrator` is special: it owns the files no agent owns, plus [orchestrator].also.
"""

from __future__ import annotations

import argparse
import fnmatch
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / ".claude" / "ownership.toml"
ORCHESTRATOR = "orchestrator"


def matches(path: str, pattern: str) -> bool:
    if pattern.endswith("/"):
        return path.startswith(pattern)
    return fnmatch.fnmatchcase(path, pattern)


def owns(rules: dict[str, Any], path: str) -> bool:
    if any(matches(path, p) for p in rules.get("exclude", [])):
        return False
    return any(matches(path, p) for p in rules.get("paths", []))


def git_paths(*args: str) -> set[str]:
    """Run git with NUL-separated output so unusual file names are never quoted or split."""
    out = subprocess.run(  # noqa: S603 - fixed git argv, no shell
        ["git", "-c", "core.quotepath=off", *args],  # noqa: S607 - git from PATH is intended
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout
    return {p.decode() for p in out.split(b"\0") if p}


def changed_files(base: str | None) -> list[str]:
    if base:
        return sorted(git_paths("diff", "--name-only", "--no-renames", "-z", f"{base}...HEAD"))
    files = git_paths("diff", "--name-only", "--no-renames", "-z", "HEAD")
    files |= git_paths("ls-files", "--others", "--exclude-standard", "-z")
    return sorted(files)


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("agents", help="agent name(s), comma-separated")
    parser.add_argument("--base", help="check committed changes since this ref instead")
    args = parser.parse_args()

    data = tomllib.loads(CONFIG.read_text())
    config: dict[str, dict[str, Any]] = data["agents"]
    orchestrator_also: list[str] = data.get("orchestrator", {}).get("also", [])
    names = [n.strip() for n in args.agents.split(",") if n.strip()]
    unknown = [n for n in names if n not in config and n != ORCHESTRATOR]
    if unknown:
        known = ", ".join([*config, ORCHESTRATOR])
        print(f"unknown agent(s): {', '.join(unknown)}; known: {known}")
        return 2

    def owned_by_any_agent(path: str) -> bool:
        return any(owns(rules, path) for rules in config.values())

    def allowed(path: str) -> bool:
        for name in names:
            if name == ORCHESTRATOR:
                if not owned_by_any_agent(path) or any(matches(path, p) for p in orchestrator_also):
                    return True
            elif owns(config[name], path):
                return True
        return False

    files = changed_files(args.base)
    violations = [f for f in files if not allowed(f)]
    print(f"{len(files)} changed file(s) checked against: {', '.join(names)}")
    if violations:
        print("OWNERSHIP VIOLATIONS (changed but not owned):")
        for f in violations:
            print(f"  {f}")
        return 1
    print("ok: all changes are within ownership")
    return 0


if __name__ == "__main__":
    sys.exit(main())
