from __future__ import annotations

from fastapi import APIRouter

from sudoku_api.deps import CurrentUserDep, DbDep
from sudoku_api.schemas.auth import MeOut, UserStatsOut
from sudoku_api.schemas.common import error_responses
from sudoku_api.services import stats

router = APIRouter(tags=["users"])


@router.get(
    "/me",
    response_model=MeOut,
    responses=error_responses(401),
    summary="Current user and personal stats",
)
def me(db: DbDep, user: CurrentUserDep) -> MeOut:
    s = stats.user_stats(db, user)
    return MeOut(
        id=user.id,
        username=user.username,
        email=user.email,
        email_verified=user.email_verified,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
        stats=UserStatsOut(
            games_started=s.games_started,
            games_completed=s.games_completed,
            total_score=s.total_score,
            best_scores=s.best_scores,
        ),
    )
