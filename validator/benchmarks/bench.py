"""Benchmark count_solutions, rate and next_hint on seeded random puzzles.

Usage (from the repo root)::

    uv run python validator/benchmarks/bench.py [--count 300] [--seed 0]

Puzzles come from the test-suite's independent digger (minimal puzzles plus
puzzles dug only down to 30-46 clues, so every level is represented).
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from collections import Counter, defaultdict
from collections.abc import Callable
from functools import partial
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sudoku_validator import Grid, count_solutions, next_hint, parse, rate
from tests.puzzle_factory import random_puzzle
from tests.reference import CLASSIC


def timed(fn: Callable[[], object]) -> float:
    start = time.perf_counter()
    fn()
    return (time.perf_counter() - start) * 1000


def summary(ms: list[float]) -> str:
    ms = sorted(ms)
    p95 = ms[min(len(ms) - 1, int(len(ms) * 0.95))]
    return (
        f"n={len(ms):4d}  mean={statistics.fmean(ms):6.2f}  median={statistics.median(ms):6.2f}"
        f"  p95={p95:6.2f}  max={ms[-1]:7.2f} ms"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=300)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    puzzles: list[tuple[Grid, Grid]] = []
    for k in range(args.count):
        seed = args.seed + k
        min_clues = 0 if k % 3 else 30 + (k // 3) % 17
        puzzles.append(random_puzzle(seed, min_clues=min_clues))

    cs_times = [timed(partial(count_solutions, g)) for g, _ in puzzles]
    print("count_solutions  ", summary(cs_times))

    by_level: dict[str, list[float]] = defaultdict(list)
    levels: Counter[str] = Counter()
    for g, _ in puzzles:
        start = time.perf_counter()
        r = rate(g)
        ms = (time.perf_counter() - start) * 1000
        level = r.difficulty.value if r.difficulty else "unsolved"
        levels[level] += 1
        by_level[level].append(ms)
    print("rate (all)       ", summary([t for ts in by_level.values() for t in ts]))
    order = ["beginner", "easy", "medium", "hard", "expert", "master", "extreme", "unsolved"]
    for level in order:
        if level in by_level:
            print(f"rate {level:<12}", summary(by_level[level]))

    hint_times = [timed(partial(next_hint, g, g, s)) for g, s in puzzles]
    print("next_hint        ", summary(hint_times))

    print("\nclassic puzzles:")
    for name, text in CLASSIC.items():
        g = parse(text)
        t_cs = timed(partial(count_solutions, g))
        start = time.perf_counter()
        r = rate(g)
        t_rate = (time.perf_counter() - start) * 1000
        level = r.difficulty.value if r.difficulty else "unsolved"
        print(f"  {name:<18} count={t_cs:6.2f} ms  rate={t_rate:7.2f} ms  {level}")

    total = sum(levels.values())
    print("\nlevel distribution:", ", ".join(f"{lv} {levels[lv] / total:.0%}" for lv in order))


if __name__ == "__main__":
    main()
