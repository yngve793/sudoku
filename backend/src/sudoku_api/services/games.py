"""Game lifecycle: create, load, autosave, check, hint, complete.

Every function that takes a `game_id` also takes the user and raises 404 when the game
belongs to someone else, so ids of other users' games are indistinguishable from missing ones.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from sudoku_api.domain import Difficulty, GameSource, GameStatus
from sudoku_api.errors import ApiError, not_found
from sudoku_api.models import Game, HintEvent, Puzzle, User, utcnow
from sudoku_api.services import puzzle_logic
from sudoku_api.services.hints import StagedHint, stage_hint
from sudoku_api.services.pool import (
    PuzzleRejectedError,
    add_to_pool,
    store_puzzle,
    take_from_pool,
)
from sudoku_api.services.puzzle_source import SourcePuzzle
from sudoku_api.services.scoring import ScoreBreakdown, compute_score, search_penalty

MAX_ELAPSED_SECONDS = 7 * 24 * 3600


@dataclass(frozen=True)
class BoardUpdate:
    current: str
    notes: dict[str, list[int]]
    elapsed_seconds: int
    version: int
    # When `update_search_tree` is False the saved tree is kept; otherwise it is replaced by
    # `search_tree` (a validated `SearchTree` dump), and None clears it.
    update_search_tree: bool = False
    search_tree: dict[str, Any] | None = None


def _load(session: Session, user: User, game_id: int) -> Game:
    game = session.get(Game, game_id)
    if game is None or game.user_id != user.id:
        raise not_found("Game")
    return game


def _require_in_progress(game: Game) -> None:
    if game.status != GameStatus.in_progress:
        raise ApiError(409, "game_not_in_progress", "This game is no longer in progress")


def ensure_givens_kept(givens: str, current: str) -> None:
    for g, c in zip(givens, current, strict=True):
        if g != "0" and g != c:
            raise ApiError(422, "givens_modified", "Given cells cannot be changed")


def ensure_search_tree_givens_kept(givens: str, search_tree: dict[str, Any] | None) -> None:
    if search_tree is not None:
        ensure_givens_kept(givens, search_tree["root_board"])


def puzzle_unavailable() -> ApiError:
    return ApiError(503, "puzzle_unavailable", "Could not produce a puzzle, please retry")


def abandon_in_progress(session: Session, user: User, now: datetime) -> None:
    """Abandon the user's in-progress game, if any (one in-progress game per user)."""
    session.execute(
        update(Game)
        .where(Game.user_id == user.id, Game.status == str(GameStatus.in_progress))
        .values(status=str(GameStatus.abandoned), updated_at=now)
    )


def was_imported(session: Session, puzzle: Puzzle) -> bool:
    """True if these givens came from a photo: never serve them as a ranked generated game."""
    if puzzle.source != GameSource.generated:
        return True
    imported = select(Game.id).where(
        Game.puzzle_id == puzzle.id, Game.source == str(GameSource.imported)
    )
    return session.scalar(imported.limit(1)) is not None


def create_game(
    session: Session,
    user: User,
    difficulty: Difficulty,
    *,
    candidate: SourcePuzzle | None = None,
    generator_version: str = "",
) -> Game | None:
    """Start a game from the pool, abandoning the user's current game.

    If the pool is empty and no `candidate` is given, nothing changes and None is returned:
    the caller should generate a candidate (off the event loop) and call again. A candidate
    goes through the validation gate; if the pool was refilled in the meantime, the candidate
    is added to the pool instead of being thrown away.
    """
    now = utcnow()
    abandon_in_progress(session, user, now)
    puzzle = take_from_pool(session, difficulty)
    if puzzle is not None and candidate is not None:
        add_to_pool(session, candidate, generator_version)
    elif puzzle is None:
        if candidate is None:
            session.rollback()
            return None
        try:
            puzzle, created = store_puzzle(session, candidate, generator_version)
        except PuzzleRejectedError:
            session.rollback()
            raise puzzle_unavailable() from None
        if not created and was_imported(session, puzzle):  # givens known from a photo
            session.rollback()
            raise puzzle_unavailable()
    game = Game(
        user_id=user.id,
        puzzle_id=puzzle.id,
        puzzle=puzzle,
        status=str(GameStatus.in_progress),
        source=str(GameSource.generated),
        current=puzzle.givens,
        notes={},
        elapsed_seconds=0,
        hints_used=0,
        mistakes=0,
        version=1,
        started_at=now,
        updated_at=now,
    )
    session.add(game)
    session.commit()
    return game


def puzzle_difficulty(game: Game) -> Difficulty | None:
    """The game's level; None for an Unrated imported puzzle."""
    level = game.puzzle.difficulty
    return None if level is None else Difficulty(level)


def get_game(session: Session, user: User, game_id: int) -> Game:
    return _load(session, user, game_id)


def get_current_game(session: Session, user: User) -> Game:
    game = session.scalar(
        select(Game).where(Game.user_id == user.id, Game.status == str(GameStatus.in_progress))
    )
    if game is None:
        raise not_found("In-progress game")
    return game


def _apply_update(session: Session, game: Game, upd: BoardUpdate, **extra: Any) -> None:
    """Optimistic-locked write of the board. Raises 409 `version_conflict` on a stale version."""
    ensure_givens_kept(game.puzzle.givens, upd.current)
    if upd.update_search_tree:
        ensure_search_tree_givens_kept(game.puzzle.givens, upd.search_tree)
        extra["search_tree"] = upd.search_tree
    elapsed = min(max(game.elapsed_seconds, upd.elapsed_seconds), MAX_ELAPSED_SECONDS)
    result = session.execute(
        update(Game)
        .where(
            Game.id == game.id,
            Game.version == upd.version,
            Game.status == str(GameStatus.in_progress),
        )
        .values(
            current=upd.current,
            notes=upd.notes,
            elapsed_seconds=elapsed,
            version=Game.version + 1,
            updated_at=utcnow(),
            **extra,
        )
        .execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        session.rollback()
        raise ApiError(
            409, "version_conflict", "The game was changed elsewhere; reload and try again"
        )
    session.refresh(game)


def save_game(session: Session, user: User, game_id: int, upd: BoardUpdate) -> Game:
    game = _load(session, user, game_id)
    _require_in_progress(game)
    _apply_update(session, game, upd)
    session.commit()
    return game


def _board_for_evaluation(game: Game, current: str | None) -> str:
    if current is None:
        return game.current
    ensure_givens_kept(game.puzzle.givens, current)
    return current


def check_game(
    session: Session, user: User, game_id: int, current: str | None = None
) -> tuple[list[int], Game]:
    """Wrong cells on the board; each wrong cell found adds one mistake."""
    game = _load(session, user, game_id)
    _require_in_progress(game)
    board = _board_for_evaluation(game, current)
    wrong = puzzle_logic.find_errors(
        puzzle_logic.parse(board), puzzle_logic.parse(game.puzzle.solution)
    )
    if wrong:
        session.execute(
            update(Game)
            .where(Game.id == game.id)
            .values(mistakes=Game.mistakes + len(wrong))
            .execution_options(synchronize_session=False)
        )
    session.commit()
    session.refresh(game)
    return wrong, game


def hint_for_game(
    session: Session, user: User, game_id: int, stage: int, current: str | None = None
) -> StagedHint:
    game = _load(session, user, game_id)
    _require_in_progress(game)
    board = _board_for_evaluation(game, current)
    hint = puzzle_logic.next_hint(
        puzzle_logic.parse(game.puzzle.givens),
        puzzle_logic.parse(board),
        puzzle_logic.parse(game.puzzle.solution),
    )
    if hint is None:
        raise ApiError(409, "no_hint_available", "The board is already solved")
    staged = stage_hint(hint, stage)
    session.add(HintEvent(game_id=game.id, level=stage, technique=hint.technique, cells=hint.cells))
    # Counter bump does not change `version`: hints are not board edits.
    session.execute(
        update(Game)
        .where(Game.id == game.id)
        .values(hints_used=Game.hints_used + 1)
        .execution_options(synchronize_session=False)
    )
    session.commit()
    return staged


@dataclass(frozen=True)
class SearchPropagation:
    propagation: puzzle_logic.Propagation
    penalty: int  # points deducted for this call's placements
    auto_placements: int  # the game's running total


def propagate_for_game(session: Session, user: User, game_id: int, board: str) -> SearchPropagation:
    """Search mode auto implications (naked/hidden singles) for a node's board.

    Constraint-only: the solution is never consulted. Each placement returned counts as an
    auto placement for scoring. Like hints, this does not change `version`, so it never
    conflicts with a concurrent autosave.
    """
    game = _load(session, user, game_id)
    _require_in_progress(game)
    ensure_givens_kept(game.puzzle.givens, board)
    result = puzzle_logic.propagate(puzzle_logic.parse(board))
    count = len(result.placements)
    if count:
        session.execute(
            update(Game)
            .where(Game.id == game.id)
            .values(auto_placements=Game.auto_placements + count)
            .execution_options(synchronize_session=False)
        )
    session.commit()
    session.refresh(game)
    return SearchPropagation(result, search_penalty(count), game.auto_placements)


def complete_game(
    session: Session, user: User, game_id: int, upd: BoardUpdate | None = None
) -> tuple[Game, ScoreBreakdown]:
    """Verify the board server-side and store the server-computed score."""
    game = _load(session, user, game_id)
    _require_in_progress(game)
    if upd is not None:
        _apply_update(session, game, upd)
    if game.current != game.puzzle.solution:
        session.commit()  # keep a just-saved board
        raise ApiError(422, "board_not_solved", "The board is not correctly solved yet")
    stages = list(
        session.scalars(select(HintEvent.level).where(HintEvent.game_id == game.id)).all()
    )
    breakdown = compute_score(
        puzzle_difficulty(game),
        game.elapsed_seconds,
        stages,
        game.mistakes,
        game.auto_placements,
    )
    now = utcnow()
    result = session.execute(
        update(Game)
        .where(Game.id == game.id, Game.status == str(GameStatus.in_progress))
        .values(
            status=str(GameStatus.completed),
            score=breakdown.total,
            completed_at=now,
            updated_at=now,
            version=Game.version + 1,
        )
        .execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        session.rollback()
        raise ApiError(409, "game_not_in_progress", "This game is no longer in progress")
    session.commit()
    session.refresh(game)
    return game, breakdown


def score_breakdown(session: Session, game: Game) -> ScoreBreakdown:
    """Recompute the breakdown of a stored game (for display)."""
    stages = list(
        session.scalars(select(HintEvent.level).where(HintEvent.game_id == game.id)).all()
    )
    return compute_score(
        puzzle_difficulty(game),
        game.elapsed_seconds,
        stages,
        game.mistakes,
        game.auto_placements,
    )
