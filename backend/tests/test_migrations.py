from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect
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
