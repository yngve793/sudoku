"""ORM models. Importing this package registers every table on `Base.metadata`."""

from sudoku_api.models.base import Base, UTCDateTime, utcnow
from sudoku_api.models.game import Game, HintEvent
from sudoku_api.models.puzzle import Puzzle, PuzzlePool
from sudoku_api.models.user import EmailToken, RefreshToken, User

__all__ = [
    "Base",
    "EmailToken",
    "Game",
    "HintEvent",
    "Puzzle",
    "PuzzlePool",
    "RefreshToken",
    "UTCDateTime",
    "User",
    "utcnow",
]
