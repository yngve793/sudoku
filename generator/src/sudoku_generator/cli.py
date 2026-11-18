"""``sudoku-gen``: batch puzzle generation to JSON lines, with optional stats.

Puzzle *i* of a batch uses seed ``S + i`` (``S`` from ``--seed`` or random), so
any line can be reproduced with ``generate(difficulty, seed=line["seed"])`` and
the output does not depend on ``--workers``.
"""

from __future__ import annotations

import argparse
import json
import secrets
import statistics
import sys
from collections.abc import Iterator, Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from typing import Any, TextIO

from sudoku_validator import Difficulty

from .generate import GenerationError, Puzzle, generate_with_stats
from .symmetry import Symmetry


@dataclass(frozen=True)
class _Job:
    difficulty: Difficulty
    seed: int
    symmetry: Symmetry
    max_attempts: int | None
    timeout: float | None


@dataclass(frozen=True)
class _Outcome:
    seed: int
    puzzle: Puzzle | None
    attempts: int
    elapsed: float
    error: str | None


def puzzle_to_json(puzzle: Puzzle) -> dict[str, Any]:
    """The JSON-lines record for *puzzle* (grids as 81-digit strings)."""
    return {
        "givens": "".join(map(str, puzzle.givens)),
        "solution": "".join(map(str, puzzle.solution)),
        "difficulty": puzzle.difficulty.value,
        "score": puzzle.rating.score,
        "techniques": dict(puzzle.rating.techniques),
        "clue_count": puzzle.clue_count,
        "seed": puzzle.seed,
    }


def _run(job: _Job) -> _Outcome:
    try:
        result = generate_with_stats(
            job.difficulty,
            seed=job.seed,
            symmetry=job.symmetry,
            max_attempts=job.max_attempts,
            timeout=job.timeout,
        )
    except GenerationError as exc:
        return _Outcome(job.seed, None, 0, 0.0, str(exc))
    return _Outcome(job.seed, result.puzzle, result.attempts, result.elapsed, None)


def _outcomes(jobs: list[_Job], workers: int) -> Iterator[_Outcome]:
    if workers <= 1:
        yield from map(_run, jobs)
        return
    with ProcessPoolExecutor(max_workers=workers) as pool:
        yield from pool.map(_run, jobs)


def _percentile(sorted_values: Sequence[float], q: float) -> float:
    index = min(len(sorted_values) - 1, max(0, round(q * len(sorted_values)) - 1))
    return sorted_values[index]


def _print_stats(difficulty: Difficulty, outcomes: list[_Outcome], out: TextIO) -> None:
    ok = [o for o in outcomes if o.puzzle is not None]
    print(f"difficulty: {difficulty.value}", file=out)
    print(f"success:    {len(ok)}/{len(outcomes)}", file=out)
    if not ok:
        return
    times = sorted(o.elapsed for o in ok)
    clues = [o.puzzle.clue_count for o in ok if o.puzzle is not None]
    scores = [o.puzzle.rating.score for o in ok if o.puzzle is not None]
    attempts = [o.attempts for o in ok]
    print(
        f"time (s):   mean {statistics.mean(times):.3f}  p50 {_percentile(times, 0.5):.3f}"
        f"  p95 {_percentile(times, 0.95):.3f}  max {times[-1]:.3f}",
        file=out,
    )
    print(f"attempts:   mean {statistics.mean(attempts):.1f}  max {max(attempts)}", file=out)
    print(
        f"clues:      mean {statistics.mean(clues):.1f}  min {min(clues)}  max {max(clues)}",
        file=out,
    )
    print(
        f"score:      mean {statistics.mean(scores):.1f}  min {min(scores)}  max {max(scores)}",
        file=out,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sudoku-gen", description="Generate validated sudoku puzzles as JSON lines."
    )
    parser.add_argument(
        "--difficulty", required=True, choices=[d.value for d in Difficulty], help="target level"
    )
    parser.add_argument("--count", type=int, default=1, help="number of puzzles (default 1)")
    parser.add_argument("--seed", type=int, default=None, help="base seed; puzzle i uses seed+i")
    parser.add_argument("--workers", type=int, default=1, help="worker processes (default 1)")
    parser.add_argument("--out", default=None, help="output .jsonl file (default stdout)")
    parser.add_argument(
        "--symmetry",
        choices=[s.value for s in Symmetry],
        default=Symmetry.ROTATIONAL.value,
        help="clue symmetry (default rotational)",
    )
    parser.add_argument("--max-attempts", type=int, default=None, help="per-puzzle attempt cap")
    parser.add_argument("--timeout", type=float, default=None, help="per-puzzle timeout (s)")
    parser.add_argument(
        "--stats",
        action="store_true",
        help="print timing/success stats to stderr; puzzles go to stdout only with --out",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.count < 1:
        raise SystemExit("sudoku-gen: --count must be at least 1")
    if args.workers < 1:
        raise SystemExit("sudoku-gen: --workers must be at least 1")
    difficulty = Difficulty(args.difficulty)
    base = secrets.randbits(62) if args.seed is None else args.seed
    jobs = [
        _Job(difficulty, base + i, Symmetry(args.symmetry), args.max_attempts, args.timeout)
        for i in range(args.count)
    ]

    sink: TextIO | None
    if args.out is not None:
        sink = open(args.out, "w", encoding="utf-8")  # noqa: SIM115 - closed below
    else:
        sink = None if args.stats else sys.stdout
    outcomes: list[_Outcome] = []
    try:
        for outcome in _outcomes(jobs, args.workers):
            outcomes.append(outcome)
            if outcome.puzzle is None:
                print(f"sudoku-gen: {outcome.error}", file=sys.stderr)
            elif sink is not None:
                sink.write(json.dumps(puzzle_to_json(outcome.puzzle)) + "\n")
                sink.flush()
    finally:
        if sink is not None and sink is not sys.stdout:
            sink.close()
    if args.stats:
        _print_stats(difficulty, outcomes, sys.stderr)
    return 0 if all(o.puzzle is not None for o in outcomes) else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
