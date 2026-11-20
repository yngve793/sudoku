"""Bounded, in-memory multipart parsing for photo uploads.

FastAPI parses a multipart body before any dependency runs, and Starlette spools file parts
larger than 1 MB to a temporary file on disk. For `POST /imports/recognize` that would mean
reading arbitrarily large bodies and writing photos to disk. `LimitedUploadRoute` instead,
before the normal handler runs:

1. applies the route's rate limit and rejects requests without credentials (cheap checks
   first, so anonymous or throttled clients cannot make us read a body);
2. rejects a declared `Content-Length` over the limit, then parses the body while counting
   bytes and aborts with 413 as soon as the limit is passed;
3. keeps file parts in memory (`spool_max_size` above the limit) and caches the parsed form
   on the request, so FastAPI's own `request.form()` reuses it.

The OpenAPI schema is unaffected: the endpoint still declares its form model.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, AsyncIterator, Callable, Coroutine
from typing import Any

from fastapi import Request, Response
from fastapi.routing import APIRoute
from starlette.datastructures import FormData
from starlette.formparsers import MultiPartException, MultiPartParser

from sudoku_api.config import Settings
from sudoku_api.errors import ApiError
from sudoku_api.ratelimit import RateLimiter, client_ip, too_many_requests
from sudoku_api.services.recognition import MAX_IMAGE_BYTES

# Room for multipart boundaries, part headers and the small `corners` field.
MULTIPART_OVERHEAD_BYTES = 64 * 1024
MAX_BODY_BYTES = MAX_IMAGE_BYTES + MULTIPART_OVERHEAD_BYTES
MAX_FIELD_BYTES = 4 * 1024


class _BodyTooLargeError(Exception):
    pass


class _InMemoryMultiPartParser(MultiPartParser):
    # Never roll a file part over to disk: the body is capped below this size.
    spool_max_size = MAX_BODY_BYTES + 1


def too_large() -> ApiError:
    return ApiError(413, "image_too_large", "The image is too large (at most 10 MB)")


async def _limited(stream: AsyncIterator[bytes], limit: int) -> AsyncGenerator[bytes, None]:
    total = 0
    async for chunk in stream:
        total += len(chunk)
        if total > limit:
            raise _BodyTooLargeError
        yield chunk


async def read_limited_form(request: Request, limit: int = MAX_BODY_BYTES) -> FormData:
    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("multipart/form-data"):
        raise ApiError(422, "validation_error", "Expected a multipart/form-data upload")
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise too_large()
    parser = _InMemoryMultiPartParser(
        request.headers,
        _limited(request.stream(), limit),
        max_files=1,
        max_fields=4,
        max_part_size=MAX_FIELD_BYTES,
    )
    try:
        return await parser.parse()
    except _BodyTooLargeError:
        raise too_large() from None
    except MultiPartException as exc:
        raise ApiError(422, "validation_error", exc.message) from None


def limited_upload_route(scope: str, limit_of: Callable[[Settings], str]) -> type[APIRoute]:
    """An `APIRoute` class for multipart upload endpoints with a per-IP rate limit `scope`."""

    class LimitedUploadRoute(APIRoute):
        def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
            handler = super().get_route_handler()

            async def limited_handler(request: Request) -> Response:
                limiter: RateLimiter = request.app.state.rate_limiter
                if not limiter.hit(limit_of(request.app.state.settings), scope, client_ip(request)):
                    raise too_many_requests()
                if not request.headers.get("authorization", "").lower().startswith("bearer "):
                    raise ApiError(
                        401,
                        "not_authenticated",
                        "Not authenticated",
                        {"WWW-Authenticate": "Bearer"},
                    )
                request._form = await read_limited_form(request)
                return await handler(request)

            return limited_handler

    return LimitedUploadRoute
