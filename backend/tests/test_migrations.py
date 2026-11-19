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
