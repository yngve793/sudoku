from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text
from sudoku_api.models import Base

BACKEND = Path(__file__).resolve().parents[1]


def _config(url: str) -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    cfg.attributes["configure_logger"] = False
    return cfg


def test_upgrade_from_empty_to_head_and_back(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'm.db'}"
    cfg = _config(url)
    command.upgrade(cfg, "head")
    engine = create_engine(url)
    tables = set(inspect(engine).get_table_names())
    assert {
        "users",
        "refresh_tokens",
        "email_tokens",
        "puzzles",
        "puzzle_pool",
        "games",
        "hint_events",
    } <= tables
    indexes = {i["name"] for i in inspect(engine).get_indexes("games")}
    assert "uq_games_user_in_progress" in indexes

    # The migrated schema matches the ORM models (no pending autogenerate diff).
    with engine.connect() as conn:
        ctx = MigrationContext.configure(conn, opts={"compare_type": True})
        diff = [
            d
            for d in compare_metadata(ctx, Base.metadata)
            # SQLite cannot reflect expression indexes (lower(username)); ignore that one.
            if "uq_users_username_lower" not in str(d)
        ]
    assert diff == []

    command.downgrade(cfg, "base")
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}
    engine.dispose()


def test_0002_adds_search_columns_to_existing_games(tmp_path: Path) -> None:
    """Upgrade 0001 -> 0002 with a game row present, then downgrade back to 0001."""
    url = f"sqlite:///{tmp_path / 'm2.db'}"
    cfg = _config(url)
    command.upgrade(cfg, "0001")
    engine = create_engine(url)
    now = "2026-11-19 00:00:00"
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, username, email, password_hash, created_at) "
                "VALUES (1, 'alice', 'a@example.com', 'x', :now)"
            ),
            {"now": now},
        )
        conn.execute(
            text(
                "INSERT INTO puzzles (id, givens, solution, difficulty, rating_score, techniques,"
                " clue_count, generator_version, created_at, validated_at) VALUES (1, :g, :s,"
                " 'easy', 1, '[]', 30, 'test', :now, :now)"
            ),
            {"g": "0" * 81, "s": "1" * 81, "now": now},
        )
        conn.execute(
            text(
                "INSERT INTO games (id, user_id, puzzle_id, status, current, notes,"
                " elapsed_seconds, hints_used, mistakes, version, started_at, updated_at)"
                " VALUES (1, 1, 1, 'in_progress', :g, '{}', 0, 0, 0, 1, :now, :now)"
            ),
            {"g": "0" * 81, "now": now},
        )

    command.upgrade(cfg, "0002")
    columns = {c["name"]: c for c in inspect(engine).get_columns("games")}
    assert columns["search_tree"]["nullable"] is True
    assert columns["auto_placements"]["nullable"] is False
    with engine.connect() as conn:
        row = conn.execute(text("SELECT search_tree, auto_placements FROM games")).one()
    assert tuple(row) == (None, 0)

    command.downgrade(cfg, "0001")
    insp = inspect(engine)
    names = {c["name"] for c in insp.get_columns("games")}
    assert not names & {"search_tree", "auto_placements"}
    assert "uq_games_user_in_progress" in {i["name"] for i in insp.get_indexes("games")}
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM games")).scalar_one() == 1
    engine.dispose()


def test_0003_photo_import_columns_and_lossy_downgrade(tmp_path: Path) -> None:
    """0002 -> 0003 keeps existing rows as `generated`; downgrading drops imported data."""
    url = f"sqlite:///{tmp_path / 'm3.db'}"
    cfg = _config(url)
    command.upgrade(cfg, "0002")
    engine = create_engine(url)
    now = "2026-11-20 00:00:00"
    puzzle_sql = (
        "INSERT INTO puzzles (id, givens, solution, difficulty, rating_score, techniques,"
        " clue_count, generator_version, created_at, validated_at {extra}) VALUES (:id, :g, :s,"
        " :d, 1, '{{}}', 30, 'test', :now, :now {extra_values})"
    )
    game_sql = (
        "INSERT INTO games (id, user_id, puzzle_id, status, current, notes, elapsed_seconds,"
        " hints_used, mistakes, version, started_at, updated_at {extra}) VALUES (:id, 1, :p,"
        " 'completed', :g, '{{}}', 0, 0, 0, 1, :now, :now {extra_values})"
    )
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, username, email, password_hash, created_at) "
                "VALUES (1, 'alice', 'a@example.com', 'x', :now)"
            ),
            {"now": now},
        )
        conn.execute(
            text(puzzle_sql.format(extra="", extra_values="")),
            {"id": 1, "g": "1" + "0" * 80, "s": "1" * 81, "d": "easy", "now": now},
        )
        conn.execute(
            text(game_sql.format(extra="", extra_values="")),
            {"id": 1, "p": 1, "g": "1" * 81, "now": now},
        )

    command.upgrade(cfg, "0003")
    insp = inspect(engine)
    puzzles = {c["name"]: c for c in insp.get_columns("puzzles")}
    games = {c["name"]: c for c in insp.get_columns("games")}
    assert puzzles["difficulty"]["nullable"] is True
    assert puzzles["source"]["nullable"] is False
    assert games["source"]["nullable"] is False
    with engine.begin() as conn:
        assert conn.execute(text("SELECT source FROM puzzles")).scalar_one() == "generated"
        assert conn.execute(text("SELECT source FROM games")).scalar_one() == "generated"
        # Imported data: an Unrated imported puzzle, and an imported game on the generated row.
        conn.execute(
            text(puzzle_sql.format(extra=", source", extra_values=", 'imported'")),
            {"id": 2, "g": "2" + "0" * 80, "s": "2" * 81, "d": None, "now": now},
        )
        conn.execute(
            text(game_sql.format(extra=", source", extra_values=", 'imported'")),
            {"id": 2, "p": 2, "g": "2" * 81, "now": now},
        )
        conn.execute(
            text(game_sql.format(extra=", source", extra_values=", 'imported'")),
            {"id": 3, "p": 1, "g": "1" * 81, "now": now},
        )
        conn.execute(
            text(
                "INSERT INTO hint_events (game_id, level, cells, created_at)"
                " VALUES (2, 1, '[]', :now)"
            ),
            {"now": now},
        )

    command.downgrade(cfg, "0002")
    insp = inspect(engine)
    assert "source" not in {c["name"] for c in insp.get_columns("puzzles")}
    assert "source" not in {c["name"] for c in insp.get_columns("games")}
    difficulty = next(c for c in insp.get_columns("puzzles") if c["name"] == "difficulty")
    assert difficulty["nullable"] is False
    with engine.connect() as conn:
        assert conn.execute(text("SELECT id FROM games")).scalars().all() == [1]
        assert conn.execute(text("SELECT id FROM puzzles")).scalars().all() == [1]
        assert conn.execute(text("SELECT count(*) FROM hint_events")).scalar_one() == 0
    engine.dispose()


def test_0004_pending_rating_is_nullable_and_downgrades_to_zero(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'm4.db'}"
    cfg = _config(url)
    command.upgrade(cfg, "0004")
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO puzzles (id, givens, solution, difficulty, source, rating_score,"
                " techniques, clue_count, generator_version, created_at, validated_at) VALUES"
                " (1, :g, :s, NULL, 'imported', NULL, '{}', 30, 'import', :now, :now)"
            ),
            {"g": "0" * 81, "s": "1" * 81, "now": "2026-11-20 00:00:00"},
        )
    command.downgrade(cfg, "0003")
    score = next(c for c in inspect(engine).get_columns("puzzles") if c["name"] == "rating_score")
    assert score["nullable"] is False
    with engine.connect() as conn:
        assert conn.execute(text("SELECT rating_score FROM puzzles")).scalar_one() == 0
    engine.dispose()
