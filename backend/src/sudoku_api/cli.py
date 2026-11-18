"""`sudoku-api` management commands.

    sudoku-api seed-pool puzzles.jsonl [--database-url URL] [--generator-version V]

Seeds `puzzle_pool` from JSON lines written by `sudoku-gen --out` (fields `givens`,
`solution`, `difficulty`, `score`, `techniques`, `clue_count`, `seed`). Every row goes through
the same validation gate as generated puzzles; the stored rating is recomputed by the
validator. Rows whose givens are already known are skipped. Exit status is 1 if any row was
malformed or rejected (valid rows are still committed).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any, TextIO

from sqlalchemy.orm import Session, sessionmaker

from sudoku_api.config import DatabaseSettings
from sudoku_api.db import make_engine, make_session_factory
from sudoku_api.domain import Difficulty
from sudoku_api.services import puzzle_logic
from sudoku_api.services.pool import AddResult, add_to_pool
from sudoku_api.services.puzzle_source import SourcePuzzle

BATCH_SIZE = 200


def _candidate(row: dict[str, Any]) -> SourcePuzzle:
    seed = row.get("seed")
    return SourcePuzzle(
        givens=str(row["givens"]),
        solution=str(row["solution"]),
        difficulty=Difficulty(row["difficulty"]),
        rating_score=int(row.get("score", 0)),
        techniques={str(k): int(v) for k, v in dict(row.get("techniques") or {}).items()},
        seed=None if seed is None else int(seed),
    )


def seed_pool(
    session_factory: sessionmaker[Session],
    lines: TextIO,
    generator_version: str,
    out: TextIO | None = None,
) -> Counter[str]:
    """Load JSON lines into the pool. Returns counts of added/duplicate/rejected/malformed."""
    out = out or sys.stdout
    counts: Counter[str] = Counter()
    with session_factory() as session:
        for lineno, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                candidate = _candidate(json.loads(line))
            except (ValueError, KeyError, TypeError) as exc:
                counts["malformed"] += 1
                print(f"line {lineno}: malformed ({exc})", file=out)
                continue
            result = add_to_pool(session, candidate, generator_version)
            counts[str(result)] += 1
            if result is AddResult.rejected:
                print(f"line {lineno}: rejected by validation gate", file=out)
            if result is AddResult.added and counts[str(result)] % BATCH_SIZE == 0:
                session.commit()
        session.commit()
    return counts


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sudoku-api", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    seed = sub.add_parser("seed-pool", help="load sudoku-gen JSON lines into the puzzle pool")
    seed.add_argument("file", type=Path, help="JSON-lines file ('-' for stdin)")
    seed.add_argument("--database-url", default=None, help="default: DATABASE_URL")
    seed.add_argument(
        "--generator-version",
        default=puzzle_logic.GENERATOR_VERSION,
        help="stored with each puzzle (default: installed sudoku-generator version)",
    )
    args = parser.parse_args(argv)

    url = args.database_url or DatabaseSettings().database_url
    engine = make_engine(url)
    try:
        factory = make_session_factory(engine)
        if str(args.file) == "-":
            counts = seed_pool(factory, sys.stdin, args.generator_version)
        else:
            with args.file.open(encoding="utf-8") as fh:
                counts = seed_pool(factory, fh, args.generator_version)
    finally:
        engine.dispose()
    summary = ", ".join(f"{k}={counts[k]}" for k in ("added", "duplicate", "rejected", "malformed"))
    print(summary)
    return 1 if counts["rejected"] or counts["malformed"] else 0


if __name__ == "__main__":
    sys.exit(main())
