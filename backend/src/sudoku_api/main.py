"""FastAPI application factory.

Run with ``uv run uvicorn sudoku_api.main:app --reload`` (``app`` is built lazily on first
access, so importing this module never requires configuration).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sudoku_api.config import Settings, get_settings
from sudoku_api.db import make_engine, make_session_factory
from sudoku_api.errors import install_error_handlers
from sudoku_api.logging_config import configure_logging
from sudoku_api.ratelimit import RateLimiter
from sudoku_api.routers import auth, games, health, me, scores
from sudoku_api.routers.scores import TTLCache
from sudoku_api.services.email import EmailSender, make_email_sender
from sudoku_api.services.generation import PuzzleGenerator
from sudoku_api.services.puzzle_source import PuzzleSource, make_puzzle_source
from sudoku_api.workers.pool import run_pool_worker

API_PREFIX = "/api/v1"
API_VERSION = "1.0.0"

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    *,
    email_sender: EmailSender | None = None,
    puzzle_source: PuzzleSource | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)
    engine = make_engine(settings.database_url)
    session_factory = make_session_factory(engine)
    source = puzzle_source or make_puzzle_source(settings)
    generator = PuzzleGenerator(source, settings.generator_processes)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        task: asyncio.Task[None] | None = None
        if settings.pool_worker_enabled and settings.pool_target_per_level > 0:
            task = asyncio.create_task(
                run_pool_worker(
                    session_factory,
                    generator,
                    settings.pool_target_per_level,
                    settings.pool_refill_interval_seconds,
                    settings.pool_generation_timeout_seconds,
                )
            )
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            generator.shutdown()
            engine.dispose()

    app = FastAPI(
        title="Sudoku API",
        version=API_VERSION,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.email_sender = email_sender or make_email_sender(settings)
    app.state.puzzle_source = source
    app.state.puzzle_generator = generator
    app.state.rate_limiter = RateLimiter(settings)
    app.state.leaderboard_cache = TTLCache()

    install_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )
    for router in (auth.router, me.router, games.router, scores.router, health.router):
        app.include_router(router, prefix=API_PREFIX)
    return app


def __getattr__(name: str) -> FastAPI:
    """Lazily build `app` for `uvicorn sudoku_api.main:app`."""
    if name == "app":
        application = create_app()
        globals()["app"] = application
        return application
    raise AttributeError(name)
