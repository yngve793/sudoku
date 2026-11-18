"""Benchmark the generator against the PLAN.md section 5.2 time targets.

Usage::

    uv run python generator/scripts/benchmark.py [--count 50] [--seed 0] [--levels hard,expert]

For each level, generates ``--count`` puzzles (seeds ``seed .. seed+count-1``)
with the default per-level budget and reports the time per puzzle (mean, p50,
p95, max), the success rate (puzzles produced within the budget), the per-attempt
hit rate, attempts per puzzle and clue counts. "target" is the PLAN mean target.
Every puzzle produced has already passed ``validate_puzzle`` inside ``generate``;
the benchmark re-validates them independently as well.
"""

from __future__ import annotations

import argparse
import statistics
import sys

from sudoku_generator import GenerationError, generate_with_stats
from sudoku_validator import Difficulty, validate_puzzle

#: PLAN.md section 5.2 mean-time targets in seconds.
TARGETS: dict[Difficulty, float] = {
    Difficulty.BEGINNER: 0.2,
    Difficulty.EASY: 0.2,
    Difficulty.MEDIUM: 0.2,
    Difficulty.HARD: 1.0,
    Difficulty.EXPERT: 5.0,
    Difficulty.MASTER: 60.0,
    Difficulty.EXTREME: 60.0,
}


def _pct(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(q * len(ordered)) - 1))]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--levels", default=",".join(d.value for d in Difficulty))
    args = parser.parse_args(argv)
    levels = [Difficulty(name.strip()) for name in args.levels.split(",") if name.strip()]

    header = (
        f"{'level':9} {'ok':>7} {'mean':>8} {'p50':>8} {'p95':>8} {'max':>8} {'target':>7}"
        f" {'att/puz':>7} {'hit/att':>7} {'clues':>9} {'pass':>4}"
    )
    print(header)
    print("-" * len(header))
    all_pass = True
    for level in levels:
        times: list[float] = []
        attempts: list[int] = []
        clues: list[int] = []
        failures = 0
        for i in range(args.count):
            try:
                result = generate_with_stats(level, seed=args.seed + i)
            except GenerationError:
                failures += 1
                continue
            puzzle = result.puzzle
            report = validate_puzzle(puzzle.givens, puzzle.solution, claimed=level)
            if not report.is_valid:
                print(f"INVALID puzzle for {level} seed {puzzle.seed}: {report.errors}")
                return 2
            times.append(result.elapsed)
            attempts.append(result.attempts)
            clues.append(puzzle.clue_count)
        ok = len(times)
        if not ok:
            print(f"{level.value:9} {ok:>3}/{args.count:<3} no puzzles generated")
            all_pass = False
            continue
        mean = statistics.mean(times)
        passed = mean < TARGETS[level] and failures == 0
        all_pass &= passed
        print(
            f"{level.value:9} {ok:>3}/{args.count:<3} {mean * 1000:7.0f}ms"
            f" {_pct(times, 0.5) * 1000:7.0f}ms {_pct(times, 0.95) * 1000:7.0f}ms"
            f" {max(times) * 1000:7.0f}ms {TARGETS[level]:6.1f}s"
            f" {statistics.mean(attempts):7.1f} {ok / sum(attempts):7.1%}"
            f" {min(clues):>4}-{max(clues):<4} {'yes' if passed else 'NO':>4}"
        )
        sys.stdout.flush()
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
