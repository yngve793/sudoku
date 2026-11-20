from __future__ import annotations

import logging
from functools import partial
from typing import Annotated

from fastapi import APIRouter, Body, Depends, status
from fastapi.concurrency import run_in_threadpool

from sudoku_api.deps import CurrentUserDep, DbDep, PuzzleGeneratorDep, SettingsDep
from sudoku_api.domain import GameSource, GameStatus
from sudoku_api.models import Game
from sudoku_api.ratelimit import hint_rate_limit, import_game_rate_limit, search_rate_limit
from sudoku_api.schemas.common import error_responses
from sudoku_api.schemas.game import (
    CheckIn,
    CheckOut,
    CompletedGameOut,
    GameOut,
    GameUpdateIn,
    HintCosts,
    HintIn,
    HintOut,
    NewGameIn,
    ScoreBreakdownOut,
)
from sudoku_api.schemas.imports import ImportBoardIn
from sudoku_api.schemas.search import (
    Contradiction,
    PropagateIn,
    PropagateOut,
    PropagationPlacementOut,
    SearchCosts,
    SearchTree,
)
from sudoku_api.services import games as game_service
from sudoku_api.services import imports as import_service
from sudoku_api.services.games import BoardUpdate
from sudoku_api.services.puzzle_source import PuzzleSourceError
from sudoku_api.services.scoring import AUTO_PLACEMENT_PENALTY, hint_cost

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/games", tags=["games"], responses=error_responses(401, 422))


def game_out(game: Game) -> GameOut:
    """Map an ORM game to the public shape. The solution is never copied."""
    return GameOut(
        id=game.id,
        difficulty=game_service.puzzle_difficulty(game),
        source=GameSource(game.source),
        status=GameStatus(game.status),
        givens=game.puzzle.givens,
        current=game.current,
        notes=game.notes or {},
        elapsed_seconds=game.elapsed_seconds,
        hints_used=game.hints_used,
        mistakes=game.mistakes,
        score=game.score,
        version=game.version,
        started_at=game.started_at,
        updated_at=game.updated_at,
        completed_at=game.completed_at,
        hint_costs=HintCosts.model_validate({str(s): hint_cost(s) for s in (1, 2, 3)}),
        search_tree=(
            None if game.search_tree is None else SearchTree.model_validate(game.search_tree)
        ),
        auto_placements=game.auto_placements,
        search_costs=SearchCosts(auto_placement=AUTO_PLACEMENT_PENALTY),
    )


def _update(body: GameUpdateIn) -> BoardUpdate:
    return BoardUpdate(
        current=body.current,
        notes=body.notes,
        elapsed_seconds=body.elapsed_seconds,
        version=body.version,
        update_search_tree="search_tree" in body.model_fields_set,
        search_tree=None if body.search_tree is None else body.search_tree.model_dump(),
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=GameOut,
    responses=error_responses(503),
    summary="Start a new game (abandons the current in-progress game, if any)",
)
async def create_game(
    body: NewGameIn,
    db: DbDep,
    user: CurrentUserDep,
    generator: PuzzleGeneratorDep,
    settings: SettingsDep,
) -> GameOut:
    # DB work runs in the threadpool; generation runs in the generator's process pool.
    game = await run_in_threadpool(game_service.create_game, db, user, body.difficulty)
    if game is None:  # pool empty for this level: generate synchronously, with a timeout
        try:
            candidate = await generator.get(body.difficulty, settings.generation_timeout_seconds)
        except PuzzleSourceError as exc:
            logger.warning("synchronous generation failed for %s: %s", body.difficulty, exc)
            raise game_service.puzzle_unavailable() from None
        game = await run_in_threadpool(
            partial(
                game_service.create_game,
                db,
                user,
                body.difficulty,
                candidate=candidate,
                generator_version=generator.source.generator_version,
            )
        )
        assert game is not None
    return game_out(game)


@router.post(
    "/import",
    status_code=status.HTTP_201_CREATED,
    response_model=GameOut,
    responses=error_responses(429),
    dependencies=[Depends(import_game_rate_limit)],
    summary="Start a game from a reviewed photo import (abandons the current in-progress game)",
    description=(
        "`givens` must be consistent with exactly one solution; `current` holds the "
        "handwritten entries and must keep every given. The puzzle is rated server-side "
        "(`difficulty` null = Unrated) and an existing identical puzzle is reused. Error "
        "codes (422): `givens_modified`, `puzzle_inconsistent`, `no_solution`, "
        "`multiple_solutions`, `validation_error`; 429 `rate_limited` "
        "(`IMPORT_GAME_RATE_LIMIT`). The game has `source: imported` and "
        "never appears on the leaderboard."
    ),
)
async def import_game(
    body: ImportBoardIn,
    db: DbDep,
    user: CurrentUserDep,
    runner: PuzzleGeneratorDep,
    settings: SettingsDep,
) -> GameOut:
    await run_in_threadpool(import_service.validate_import_board, body.givens, body.current)
    rating = None
    if await run_in_threadpool(import_service.needs_rating, db, body.givens):
        rating = await import_service.rate_import(
            runner, body.givens, settings.import_rating_timeout_seconds
        )
    game = await run_in_threadpool(
        import_service.import_game, db, user, body.givens, body.current, rating
    )
    return game_out(game)


@router.get(
    "/current",
    response_model=GameOut,
    responses=error_responses(404),
    summary="The in-progress game, to resume",
)
def current_game(db: DbDep, user: CurrentUserDep) -> GameOut:
    return game_out(game_service.get_current_game(db, user))


@router.get(
    "/{game_id}",
    response_model=GameOut,
    responses=error_responses(404),
    summary="Game state (owner only)",
)
def get_game(game_id: int, db: DbDep, user: CurrentUserDep) -> GameOut:
    return game_out(game_service.get_game(db, user, game_id))


@router.patch(
    "/{game_id}",
    response_model=GameOut,
    responses=error_responses(404, 409),
    summary="Autosave board, notes, timer and search tree (optimistic lock on `version`)",
    description=(
        "`search_tree` is optional: omit it to keep the saved tree, send `null` to clear it. "
        "Its `root_board` must keep the givens (422 `givens_modified`)."
    ),
)
def save_game(game_id: int, body: GameUpdateIn, db: DbDep, user: CurrentUserDep) -> GameOut:
    return game_out(game_service.save_game(db, user, game_id, _update(body)))


@router.post(
    "/{game_id}/hint",
    response_model=HintOut,
    responses=error_responses(404, 409, 429),
    dependencies=[Depends(hint_rate_limit)],
    summary="Next hint at stage 1 (technique + region), 2 (cells) or 3 (value)",
)
def hint(game_id: int, body: HintIn, db: DbDep, user: CurrentUserDep) -> HintOut:
    staged = game_service.hint_for_game(db, user, game_id, body.stage, body.current)
    return HintOut(
        kind=staged.kind,
        stage=body.stage,
        technique=staged.technique,
        cells=staged.cells,
        value=staged.value,
        explanation=staged.explanation,
        penalty=staged.penalty,
    )


@router.post(
    "/{game_id}/search/propagate",
    response_model=PropagateOut,
    responses=error_responses(404, 409, 429),
    dependencies=[Depends(search_rate_limit)],
    summary="Search mode: direct implications (naked/hidden singles) of a node's board",
    description=(
        "Constraint-only (never compares with the solution). Every returned placement counts "
        "as an auto placement and costs `search_costs.auto_placement` points. Does not change "
        "`version`. 422 `givens_modified` if `board` changes a given."
    ),
)
def search_propagate(
    game_id: int, body: PropagateIn, db: DbDep, user: CurrentUserDep
) -> PropagateOut:
    result = game_service.propagate_for_game(db, user, game_id, body.board)
    prop = result.propagation
    c = prop.contradiction
    return PropagateOut(
        placements=[
            PropagationPlacementOut(cell=p.cell, value=p.value, technique=p.technique)
            for p in prop.placements
        ],
        contradiction=None
        if c is None
        else Contradiction(
            kind=c.kind,
            cells=list(c.cells),
            digit=c.digit,
            unit=c.unit,
            explanation=c.explanation,
        ),
        penalty=result.penalty,
        auto_placements=result.auto_placements,
    )


@router.post(
    "/{game_id}/check",
    response_model=CheckOut,
    responses=error_responses(404, 409),
    summary="Indices of wrong cells; each wrong cell counts as a mistake",
)
def check(
    game_id: int,
    db: DbDep,
    user: CurrentUserDep,
    body: Annotated[CheckIn | None, Body()] = None,
) -> CheckOut:
    wrong, game = game_service.check_game(db, user, game_id, body.current if body else None)
    return CheckOut(wrong_cells=wrong, mistakes=game.mistakes)


@router.post(
    "/{game_id}/complete",
    response_model=CompletedGameOut,
    responses=error_responses(404, 409),
    summary="Verify the solved board server-side and store the computed score",
    description=(
        "Optionally include the final board (same shape as PATCH) to save and complete in one "
        "call. Any client-sent score is ignored; the score is computed on the server."
    ),
)
def complete(
    game_id: int,
    db: DbDep,
    user: CurrentUserDep,
    body: Annotated[GameUpdateIn | None, Body()] = None,
) -> CompletedGameOut:
    game, breakdown = game_service.complete_game(db, user, game_id, _update(body) if body else None)
    return CompletedGameOut(
        **game_out(game).model_dump(by_alias=True),
        score_breakdown=ScoreBreakdownOut(
            base=breakdown.base,
            par_seconds=breakdown.par_seconds,
            time_factor=breakdown.time_factor,
            hint_penalty=breakdown.hint_penalty,
            mistake_penalty=breakdown.mistake_penalty,
            search_penalty=breakdown.search_penalty,
            total=breakdown.total,
        ),
    )
