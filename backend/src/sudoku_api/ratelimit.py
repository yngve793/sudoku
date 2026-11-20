"""Rate limiting built on slowapi's `Limiter` (storage + strategy from the `limits` library).

slowapi's decorators bind to a module-global limiter at import time. Instead, each app gets
its own `RateLimiter` (on `app.state`), and routes opt in with the `rate_limit(...)` dependency.
That keeps limits configurable per app instance and lets tests reset or disable them.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Request
from limits import RateLimitItem, parse
from slowapi import Limiter
from slowapi.util import get_remote_address

from sudoku_api.config import Settings
from sudoku_api.errors import ApiError


class RateLimiter:
    def __init__(self, settings: Settings) -> None:
        self.enabled = settings.rate_limit_enabled
        self._limiter = Limiter(
            key_func=get_remote_address,
            storage_uri=settings.rate_limit_storage_uri,
            strategy="moving-window",
            enabled=settings.rate_limit_enabled,
        )
        self._parsed: dict[str, RateLimitItem] = {}

    def _item(self, limit: str) -> RateLimitItem:
        item = self._parsed.get(limit)
        if item is None:
            item = self._parsed[limit] = parse(limit)
        return item

    def hit(self, limit: str, scope: str, key: str) -> bool:
        """Consume one unit; False when the limit is exceeded."""
        if not self.enabled:
            return True
        return bool(self._limiter.limiter.hit(self._item(limit), scope, key))

    def reset(self) -> None:
        self._limiter.reset()


def too_many_requests() -> ApiError:
    return ApiError(429, "rate_limited", "Too many requests, please slow down")


def client_ip(request: Request) -> str:
    return str(get_remote_address(request))


def rate_limit(scope: str, limit_of: Callable[[Settings], str]) -> Callable[[Request], None]:
    """Dependency factory: per-client-IP limit for a group of routes."""

    def dependency(request: Request) -> None:
        limiter: RateLimiter = request.app.state.rate_limiter
        settings: Settings = request.app.state.settings
        if not limiter.hit(limit_of(settings), scope, client_ip(request)):
            raise too_many_requests()

    return dependency


auth_rate_limit = rate_limit("auth", lambda s: s.auth_rate_limit)
refresh_rate_limit = rate_limit("refresh", lambda s: s.refresh_rate_limit)
hint_rate_limit = rate_limit("hint", lambda s: s.hint_rate_limit)
search_rate_limit = rate_limit("search", lambda s: s.search_rate_limit)
import_rate_limit = rate_limit("import", lambda s: s.import_rate_limit)
import_game_rate_limit = rate_limit("import_game", lambda s: s.import_game_rate_limit)
import_check_rate_limit = rate_limit("import_check", lambda s: s.import_check_rate_limit)
