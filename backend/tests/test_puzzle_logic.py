"""Fixture puzzles, the validator adapter and staged-hint disclosure."""

from __future__ import annotations

import re

import pytest
from sudoku_api.domain import Difficulty
from sudoku_api.services import puzzle_logic as pl
from sudoku_api.services.hints import choose_region, redact_value, stage_hint, unit_cells
from sudoku_api.services.puzzle_source import (
    _FIXTURES,
    FixturePuzzleSource,
    GeneratorPuzzleSource,
    NoPuzzleAvailableError,
)

LABELLED = [(d, g, s) for d, items in _FIXTURES.items() for g, s in items]
CELL_NAME = re.compile(r"r\dc\d")


@pytest.mark.parametrize(("level", "givens", "solution"), LABELLED)
def test_fixture_is_valid_and_truthfully_rated(
    level: Difficulty, givens: str, solution: str
) -> None:
    report = pl.validate_puzzle(pl.parse(givens), pl.parse(solution), claimed=level)
    assert report.is_valid, report.errors
    assert report.solution_count == 1
    assert pl.rated_difficulty(report.rating) == level


def test_relabelled_fixture_fails_the_gate() -> None:
    givens, solution = _FIXTURES[Difficulty.easy][0]
    report = pl.validate_puzzle(pl.parse(givens), pl.parse(solution), claimed=Difficulty.extreme)
    assert not report.is_valid
    assert report.difficulty_matches is False


def test_transformed_fixtures_keep_their_level() -> None:
    src = FixturePuzzleSource(seed=42)
    seen = set()
    for d in Difficulty:
        for _ in range(3):
            p = src.get(d)
            rating = pl.rate(pl.parse(p.givens))
            assert pl.rated_difficulty(rating) == d
            assert p.rating_score == rating.score
            assert p.techniques == rating.techniques
            assert pl.validate_puzzle(pl.parse(p.givens), pl.parse(p.solution), d).is_valid
            seen.add(p.givens)
    assert len(seen) == 3 * len(Difficulty)


def test_fixture_source_is_deterministic() -> None:
    a = FixturePuzzleSource(seed=7)
    b = FixturePuzzleSource(seed=7)
    assert [a.get(Difficulty.hard) for _ in range(3)] == [b.get(Difficulty.hard) for _ in range(3)]


def test_fixture_source_with_empty_level() -> None:
    src = FixturePuzzleSource(fixtures={Difficulty.easy: _FIXTURES[Difficulty.easy]})
    assert src.get(Difficulty.easy).difficulty == Difficulty.easy
    with pytest.raises(NoPuzzleAvailableError):
        src.get(Difficulty.master)


def test_generator_source_uses_adapter() -> None:
    p = GeneratorPuzzleSource().get(Difficulty.master)
    assert p.difficulty == Difficulty.master
    assert pl.validate_puzzle(pl.parse(p.givens), pl.parse(p.solution), Difficulty.master).is_valid


def test_validate_rejects_bad_input() -> None:
    _, givens, solution = LABELLED[0]
    g, s = pl.parse(givens), pl.parse(solution)
    assert pl.validate_puzzle(g).is_valid  # the real validator can solve it itself
    first = next(i for i, v in enumerate(g) if v)
    other = next(i for i in range(first // 9 * 9, first // 9 * 9 + 9) if i != first)
    dup = list(g)
    dup[other] = g[first]
    assert not pl.validate_puzzle(tuple(dup), s).is_consistent
    wrong = (s[1], s[0], *s[2:])
    assert pl.validate_puzzle(g, wrong).solution_matches is False
    assert not pl.validate_puzzle((0,) * 81).is_valid  # many solutions
    with pytest.raises(ValueError, match="81"):
        pl.parse("123")


def test_find_errors() -> None:
    _, givens, solution = LABELLED[0]
    g, s = pl.parse(givens), pl.parse(solution)
    i = g.index(0)
    cur = list(g)
    cur[i] = s[i] % 9 + 1
    assert pl.find_errors(tuple(cur), s) == [i]
    hint = pl.next_hint(g, tuple(cur), s)
    assert hint is not None
    assert hint.kind == "error"
    assert hint.cells == [i]
    assert pl.next_hint(g, s, s) is None


# --- staged disclosure -----------------------------------------------------------------------


def _value_mentioned(text: str, value: int) -> bool:
    """True if `value` appears as a stand-alone digit outside unit numbers."""
    return bool(
        re.search(
            rf"(?<!row )(?<!rows )(?<!column )(?<!columns )(?<!box )(?<!type )"
            rf"\b{value}\b(?! cells| further)",
            text,
        )
    )


def _assert_no_leaks(hint: pl.Hint) -> None:
    s1, s2, s3 = (stage_hint(hint, n) for n in (1, 2, 3))
    assert s1.value is None
    assert s2.value is None
    assert s3.value == hint.value
    assert s3.explanation == hint.explanation
    if hint.kind == "error":
        assert s1.cells == []
        assert not CELL_NAME.search(s1.explanation)
        assert s2.cells == hint.cells
        return
    # Stage 1: a full region around the anchor cell, no cell names and no digits except the
    # region number.
    assert len(s1.cells) == 9
    assert hint.cells[0] in s1.cells
    assert not CELL_NAME.search(s1.explanation)
    assert re.findall(r"\d", s1.explanation.replace(hint.technique or "", "")) == [
        re.search(r"(?:row|column|box) (\d)", s1.explanation).group(1)  # type: ignore[union-attr]
    ]
    # Stage 2: exact cells, explanation with the value redacted.
    assert s2.cells == hint.cells
    if hint.value is not None:
        assert not _value_mentioned(s2.explanation, hint.value), s2.explanation
        assert "This leads to" not in s2.explanation
        assert "further deduction" not in s2.explanation


@pytest.mark.parametrize(("level", "givens", "solution"), LABELLED)
def test_no_stage_leaks_while_solving(level: Difficulty, givens: str, solution: str) -> None:
    """Follow the validator's hints to the end; check every staged hint on the way."""
    g, s = pl.parse(givens), pl.parse(solution)
    current = list(g)
    techniques = set()
    for _ in range(81):
        hint = pl.next_hint(g, tuple(current), s)
        if hint is None:
            break
        _assert_no_leaks(hint)
        techniques.add(hint.technique)
        target = hint.cells[0] if hint.value is not None else current.index(0)
        current[target] = s[target]
    assert tuple(current) == s
    # An error hint too: make one wrong entry.
    i = g.index(0)
    bad = list(g)
    bad[i] = s[i] % 9 + 1
    err = pl.next_hint(g, tuple(bad), s)
    assert err is not None
    _assert_no_leaks(err)


def test_stage_one_wording_and_region() -> None:
    hint = pl.Hint("step", "X-Wing", [40, 4, 76], 7, "X-Wing: ... so r5c5 = 7.")
    s1 = stage_hint(hint, 1)
    assert s1.explanation == "Try an X-Wing in column 5."
    assert s1.cells == unit_cells("column", 4)
    single = stage_hint(pl.Hint("step", "Naked Single", [40], 7, "x"), 1)
    assert single.explanation == "Try a Naked Single in box 5."
    reveal = stage_hint(pl.Hint("step", None, [0], 3, "r1c1 = 3."), 1)
    assert reveal.explanation == "No simple technique applies here; look closely at box 1."
    locked = stage_hint(pl.Hint("step", "Locked Candidates", [0], 3, "x"), 1)
    assert locked.explanation == "Try Locked Candidates in box 1."
    err = stage_hint(pl.Hint("error", None, [3], None, "r1c4 is incorrect."), 1)
    assert err.explanation == "Your board contains a mistake."
    assert err.cells == []


def test_choose_region_prefers_unit_with_most_cells() -> None:
    assert choose_region([0, *unit_cells("row", 0)])[:2] == ("row", 0)
    assert choose_region([0])[:2] == ("box", 0)


def test_redact_value() -> None:
    text = (
        "Hidden Single: in row 4, 4 can only go in r4c4, so r4c4 = 4. "
        "This leads to: Naked Single: so r1c1 = 4."
    )
    out = redact_value(text, 30, 4)
    assert out == (
        "Hidden Single: in row 4, ? can only go in r4c4, so r4c4 = ?. "
        "This unlocks the value of r4c4."
    )
    assert redact_value("in box 3, these 3 cells hold 3/5", 0, 3) == (
        "in box 3, these 3 cells hold ?/5"
    )
