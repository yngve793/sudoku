from __future__ import annotations

import importlib
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from sudoku_generator import (
    DEFAULT_MAX_ATTEMPTS,
    GenerationError,
    Puzzle,
    Symmetry,
    generate,
    generate_with_stats,
)
from sudoku_validator import Difficulty, ValidationReport, validate_puzzle

gen_module = importlib.import_module("sudoku_generator.generate")

ALL_LEVELS = list(Difficulty)
FAST_LEVELS = [Difficulty.BEGINNER, Difficulty.EASY, Difficulty.MEDIUM, Difficulty.EXPERT]


def assert_valid(puzzle: Puzzle, level: Difficulty, symmetry: Symmetry) -> None:
    assert puzzle.difficulty is level
    assert puzzle.rating.difficulty is level
    report = validate_puzzle(puzzle.givens, puzzle.solution, claimed=level)
    assert report.is_valid, report.errors
    assert symmetry.is_symmetric(puzzle.givens)
    assert puzzle.clue_count == sum(1 for v in puzzle.givens if v)
    assert all(g in (0, s) for g, s in zip(puzzle.givens, puzzle.solution, strict=True))


@pytest.mark.parametrize("level", ALL_LEVELS)
def test_every_level_generates_a_valid_puzzle(level: Difficulty) -> None:
    puzzle = generate(level, seed=11)
    assert_valid(puzzle, level, Symmetry.ROTATIONAL)
    assert puzzle.seed == 11


@settings(max_examples=12, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(seed=st.integers(min_value=0, max_value=2**63), level=st.sampled_from(FAST_LEVELS))
def test_property_generated_puzzles_pass_validator(seed: int, level: Difficulty) -> None:
    assert_valid(generate(level, seed=seed), level, Symmetry.ROTATIONAL)


@pytest.mark.parametrize("level", [Difficulty.EASY, Difficulty.HARD])
def test_same_seed_same_puzzle(level: Difficulty) -> None:
    a = generate(level, seed=1234)
    b = generate(level, seed=1234)
    assert a.givens == b.givens
    assert a.solution == b.solution
    assert a.rating.score == b.rating.score


def test_different_seeds_differ() -> None:
    givens = {generate(Difficulty.EASY, seed=s).givens for s in range(5)}
    assert len(givens) == 5


def test_seed_none_draws_and_records_a_seed() -> None:
    puzzle = generate(Difficulty.BEGINNER)
    assert isinstance(puzzle.seed, int)
    assert generate(Difficulty.BEGINNER, seed=puzzle.seed).givens == puzzle.givens


def test_accepts_string_levels() -> None:
    puzzle = generate("easy", seed=3, symmetry="none")  # type: ignore[arg-type]
    assert puzzle.difficulty is Difficulty.EASY


@pytest.mark.parametrize("symmetry", list(Symmetry))
def test_symmetry_is_respected(symmetry: Symmetry) -> None:
    puzzle = generate(Difficulty.MEDIUM, seed=5, symmetry=symmetry)
    assert_valid(puzzle, Difficulty.MEDIUM, symmetry)


def test_beginner_digs_up_to_its_score_band() -> None:
    puzzle = generate(Difficulty.BEGINNER, seed=2)
    assert puzzle.clue_count <= 48
    assert puzzle.rating.score > 25


def test_stats_report_attempts_and_time() -> None:
    result = generate_with_stats(Difficulty.MASTER, seed=0)
    assert result.attempts >= 1
    assert result.elapsed > 0
    assert_valid(result.puzzle, Difficulty.MASTER, Symmetry.ROTATIONAL)


def test_max_attempts_scales_by_level() -> None:
    ranks = [DEFAULT_MAX_ATTEMPTS[level] for level in ALL_LEVELS]
    assert ranks == sorted(ranks)


def test_generation_error_when_attempts_exhausted(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def never(*_: Any) -> None:
        nonlocal calls
        calls += 1

    monkeypatch.setattr(gen_module, "_attempt", never)
    with pytest.raises(GenerationError, match="3 attempts"):
        generate(Difficulty.HARD, seed=1, max_attempts=3)
    assert calls == 3


def test_generation_error_on_real_budget() -> None:
    # Seed 0's first master attempt does not hit master (5% per-attempt rate).
    with pytest.raises(GenerationError):
        generate(Difficulty.MASTER, seed=0, max_attempts=1)


def test_generation_error_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gen_module, "_attempt", lambda *_: None)
    with pytest.raises(GenerationError, match="timed out"):
        generate(Difficulty.EXTREME, seed=1, timeout=0.0, max_attempts=10**9)


def test_invalid_max_attempts() -> None:
    with pytest.raises(ValueError, match="max_attempts"):
        generate(Difficulty.EASY, seed=1, max_attempts=0)


def test_final_gate_rejects_what_the_validator_rejects(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[Difficulty | None] = []

    def reject(givens: Any, solution: Any, claimed: Difficulty | None = None) -> ValidationReport:
        seen.append(claimed)
        real = validate_puzzle(givens, solution, claimed=claimed)
        return ValidationReport(
            False,
            real.is_consistent,
            real.solution_count,
            real.solution_matches,
            real.rating,
            real.difficulty_matches,
            ["rejected by test"],
        )

    monkeypatch.setattr(gen_module, "validate_puzzle", reject)
    with pytest.raises(GenerationError):
        generate(Difficulty.EASY, seed=1, max_attempts=2)
    assert seen == [Difficulty.EASY, Difficulty.EASY]


@pytest.mark.slow
@pytest.mark.parametrize("level", ALL_LEVELS)
def test_sweep_100_seeds_per_level(level: Difficulty) -> None:
    """PLAN.md section 8: 100 puzzles per level all pass validate_puzzle."""
    for seed in range(100):
        assert_valid(generate(level, seed=seed), level, Symmetry.ROTATIONAL)


@pytest.mark.slow
@pytest.mark.parametrize("level", [Difficulty.MASTER, Difficulty.EXTREME])
@pytest.mark.parametrize("symmetry", [Symmetry.NONE, Symmetry.DIAGONAL])
def test_sweep_other_symmetries(level: Difficulty, symmetry: Symmetry) -> None:
    for seed in range(10):
        assert_valid(generate(level, seed=seed, symmetry=symmetry), level, symmetry)
