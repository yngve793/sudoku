from __future__ import annotations

import logging

from fastapi import APIRouter, Response
from sqlalchemy import text

from sudoku_api.deps import DbDep
from sudoku_api.schemas.scores import HealthOut

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


@router.get(
    "/health",
    response_model=HealthOut,
    responses={503: {"model": HealthOut, "description": "Database unavailable"}},
    summary="Liveness and readiness",
)
def health(db: DbDep, response: Response) -> HealthOut:
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        logger.exception("health check: database unavailable")
        response.status_code = 503
        return HealthOut(status="degraded", database="unavailable")
    return HealthOut(status="ok", database="ok")
