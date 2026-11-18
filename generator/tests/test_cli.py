from __future__ import annotations

import importlib
import json
import re
from pathlib import Path
from typing import Any

import pytest
from sudoku_generator.cli import main
from sudoku_validator import Difficulty, validate_puzzle

gen_module = importlib.import_module("sudoku_generator.generate")

KEYS = {"givens", "solution", "difficulty", "score", "techniques", "clue_count", "seed"}


def check_record(record: dict[str, Any], level: str) -> None:
    assert set(record) == KEYS
    assert re.fullmatch(r"[0-9]{81}", record["givens"])
    assert re.fullmatch(r"[1-9]{81}", record["solution"])
    assert record["difficulty"] == level
    assert record["clue_count"] == sum(1 for c in record["givens"] if c != "0")
    assert isinstance(record["score"], int)
    assert all(isinstance(v, int) for v in record["techniques"].values())
    givens = tuple(int(c) for c in record["givens"])
    solution = tuple(int(c) for c in record["solution"])
    report = validate_puzzle(givens, solution, claimed=Difficulty(level))
    assert report.is_valid, report.errors
    assert report.rating.score == record["score"]


def test_writes_jsonl_file(tmp_path: Path) -> None:
    out = tmp_path / "p.jsonl"
    assert main(["--difficulty", "medium", "--count", "3", "--seed", "7", "--out", str(out)]) == 0
    records = [json.loads(line) for line in out.read_text().splitlines()]
    assert [r["seed"] for r in records] == [7, 8, 9]
    for record in records:
        check_record(record, "medium")


def test_writes_stdout_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--difficulty", "beginner", "--seed", "1"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    check_record(json.loads(lines[0]), "beginner")


def test_workers_give_the_same_output(tmp_path: Path) -> None:
    serial, parallel = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    base = ["--difficulty", "easy", "--count", "4", "--seed", "3"]
    assert main([*base, "--out", str(serial)]) == 0
    assert main([*base, "--workers", "2", "--out", str(parallel)]) == 0
    assert serial.read_text() == parallel.read_text()


def test_stats_mode(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--difficulty", "easy", "--count", "2", "--seed", "1", "--stats"]) == 0
    captured = capsys.readouterr()
    assert captured.out == ""  # stats-only run: no puzzles without --out
    assert "success:    2/2" in captured.err
    assert "time (s):" in captured.err


def test_failure_exit_code(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(gen_module, "_attempt", lambda *_: None)
    code = main(
        ["--difficulty", "hard", "--count", "2", "--seed", "1", "--max-attempts", "1", "--stats"]
    )
    assert code == 1
    err = capsys.readouterr().err
    assert "no hard puzzle found" in err
    assert "success:    0/2" in err


@pytest.mark.parametrize(
    "args",
    [
        ["--difficulty", "impossible"],
        ["--difficulty", "easy", "--count", "0"],
        ["--difficulty", "easy", "--workers", "0"],
    ],
)
def test_bad_arguments(args: list[str]) -> None:
    with pytest.raises(SystemExit) as info:
        main(args)
    assert info.value.code != 0
