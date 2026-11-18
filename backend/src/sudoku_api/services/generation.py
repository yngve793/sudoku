"""Run puzzle generation off the event loop.

Generation is CPU-bound pure Python. In a thread it would hold the GIL and slow down request
handling, so with `GENERATOR_PROCESSES > 0` generator jobs run in a small `spawn`-context
process pool. Sources that cannot run in another process (fixtures) and
`GENERATOR_PROCESSES = 0` (tests) use a worker thread instead.
"""

from __future__ import annotations

import asyncio
import logging
import multiprocessing
import threading
from collections.abc import Callable
from concurrent.futures import Executor, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from functools import partial

from sudoku_api.domain import Difficulty
from sudoku_api.services.puzzle_source import (
    ProcessPuzzleSource,
    PuzzleGenerationError,
    PuzzleSource,
    SourcePuzzle,
)

logger = logging.getLogger(__name__)

# The generator checks its own timeout between attempts, so it can overrun by one attempt.
TIMEOUT_GRACE_SECONDS = 2.0


class PuzzleGenerator:
    def __init__(self, source: PuzzleSource, processes: int = 0) -> None:
        self.source = source
        self._processes = processes
        self._executor: ProcessPoolExecutor | None = None
        self._lock = threading.Lock()

    @property
    def uses_processes(self) -> bool:
        return self._processes > 0 and isinstance(self.source, ProcessPuzzleSource)

    def _process_executor(self) -> ProcessPoolExecutor:
        with self._lock:
            if self._executor is None:  # created lazily: importing/building the app is cheap
                self._executor = ProcessPoolExecutor(
                    max_workers=self._processes, mp_context=multiprocessing.get_context("spawn")
                )
            return self._executor

    def _discard_executor(self) -> None:
        with self._lock:
            if self._executor is not None:
                self._executor.shutdown(wait=False, cancel_futures=True)
                self._executor = None

    async def get(self, difficulty: Difficulty, timeout: float | None = None) -> SourcePuzzle:
        """A candidate puzzle, or `PuzzleSourceError` (including timeouts)."""
        executor: Executor | None
        job: Callable[[], SourcePuzzle]
        if self.uses_processes:
            assert isinstance(self.source, ProcessPuzzleSource)
            job = self.source.job(difficulty, timeout)
            executor = self._process_executor()
        else:
            job = partial(self.source.get, difficulty, timeout)
            executor = None  # the loop's default thread pool
        future = asyncio.get_running_loop().run_in_executor(executor, job)
        limit = None if timeout is None else timeout + TIMEOUT_GRACE_SECONDS
        try:
            return await asyncio.wait_for(future, limit)
        except TimeoutError:
            raise PuzzleGenerationError(
                f"generating a {difficulty} puzzle took longer than {timeout} s"
            ) from None
        except BrokenProcessPool:
            logger.exception("generator process pool broke; it will be recreated")
            self._discard_executor()
            raise PuzzleGenerationError("generator worker crashed") from None

    def shutdown(self) -> None:
        self._discard_executor()
