"""Background task that keeps `puzzle_pool` topped up."""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy.orm import Session, sessionmaker

from sudoku_api.domain import Difficulty
from sudoku_api.services.generation import PuzzleGenerator
from sudoku_api.services.pool import RefillPass, add_to_pool_committed
from sudoku_api.services.puzzle_source import NoPuzzleAvailableError, PuzzleSourceError

logger = logging.getLogger(__name__)


async def refill_pool_async(
    session_factory: sessionmaker[Session],
    generator: PuzzleGenerator,
    target_per_level: int,
    timeout: float | None = None,
) -> dict[Difficulty, int]:
    """One refill pass, one puzzle at a time, always for the level with the fewest puzzles.

    Generation runs in the generator's process pool (or a thread); DB work runs in a thread.
    The event loop is never blocked.
    """
    refill = RefillPass(target_per_level)

    def next_level() -> Difficulty | None:
        with session_factory() as session:
            return refill.next_level(session)

    while (level := await asyncio.to_thread(next_level)) is not None:
        try:
            candidate = await generator.get(level, timeout)
        except NoPuzzleAvailableError:
            refill.unavailable(level)
            continue
        except PuzzleSourceError as exc:
            logger.warning("puzzle generation failed for %s: %s", level, exc)
            refill.record(level, None)
            continue
        result = await asyncio.to_thread(
            add_to_pool_committed, session_factory, candidate, generator.source.generator_version
        )
        refill.record(level, result)
    return refill.added


async def run_pool_worker(
    session_factory: sessionmaker[Session],
    generator: PuzzleGenerator,
    target_per_level: int,
    interval_seconds: float,
    timeout: float | None = None,
) -> None:
    """Refill forever, sleeping `interval_seconds` between passes."""
    while True:
        try:
            added = await refill_pool_async(session_factory, generator, target_per_level, timeout)
            if any(added.values()):
                logger.info("puzzle pool refilled: %s", {str(k): v for k, v in added.items()})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("puzzle pool refill failed")
        await asyncio.sleep(interval_seconds)
