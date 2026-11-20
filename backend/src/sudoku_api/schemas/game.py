from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from sudoku_api.domain import Difficulty, GameSource, GameStatus
from sudoku_api.schemas.common import Grid, Notes
from sudoku_api.schemas.search import SearchCosts, SearchTree

ElapsedSeconds = Annotated[int, Field(ge=0, le=7 * 24 * 3600)]


class NewGameIn(BaseModel):
    difficulty: Difficulty


class HintCosts(BaseModel):
    """Points each hint stage costs, keyed by stage: `{"1": int, "2": int, "3": int}`."""

    model_config = ConfigDict(
        validate_by_name=True, validate_by_alias=True, serialize_by_alias=True
    )

    stage_1: int = Field(alias="1")
    stage_2: int = Field(alias="2")
    stage_3: int = Field(alias="3")


class GameOut(BaseModel):
    """Game state. Deliberately has no `solution` field."""

    id: int
    difficulty: Difficulty | None = Field(
        description="Rated difficulty; null only for imported puzzles that are Unrated"
    )
    source: GameSource = Field(description="`imported` games are excluded from the leaderboard")
    status: GameStatus
    givens: str
    current: str
    notes: dict[str, list[int]]
    elapsed_seconds: int
    hints_used: int
    mistakes: int
    score: int | None
    version: int
    started_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    hint_costs: HintCosts
    search_tree: SearchTree | None = Field(description="The saved search-mode tree, if any")
    auto_placements: int = Field(description="Cells auto-filled by search propagation")
    search_costs: SearchCosts


class GameUpdateIn(BaseModel):
    """Autosave payload. Unknown fields (e.g. a client-sent `score`) are ignored."""

    current: Grid
    notes: Notes = Field(default_factory=dict)
    elapsed_seconds: ElapsedSeconds
    version: Annotated[int, Field(ge=1)]
    search_tree: SearchTree | None = Field(
        default=None,
        description="Search-mode tree. Omit to keep the saved tree; send null to clear it.",
    )


class HintIn(BaseModel):
    stage: Literal[1, 2, 3]
    current: Grid | None = Field(
        default=None,
        description="Optional unsaved board to compute the hint from (not persisted).",
    )


class HintOut(BaseModel):
    kind: Literal["error", "step"]
    stage: Literal[1, 2, 3]
    technique: str | None
    cells: list[int]
    value: int | None
    explanation: str
    penalty: int = Field(description="Points this hint deducts from the final score")


class CheckIn(BaseModel):
    current: Grid | None = Field(
        default=None,
        description="Optional unsaved board to check (not persisted).",
    )


class CheckOut(BaseModel):
    wrong_cells: list[int]
    mistakes: int


class ScoreBreakdownOut(BaseModel):
    base: int
    par_seconds: int
    time_factor: float
    hint_penalty: int
    mistake_penalty: int
    search_penalty: int
    total: int


class CompletedGameOut(GameOut):
    score_breakdown: ScoreBreakdownOut
