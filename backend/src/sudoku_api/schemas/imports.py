"""Photo-import schemas (PLAN.md §5.6): recognition, live review check, and game import.

`RecognitionOut` mirrors `sudoku_vision.Recognition` field for field, with JSON-friendly
shapes: `alternatives` is `[{digit, p}]` and `image_size` is `{width, height}`. `corners` uses
the same `[x, y]` pair format as the `corners` form field, so the review UI can send back
what it received.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import UploadFile
from pydantic import BaseModel, Field

from sudoku_api.domain import Difficulty
from sudoku_api.schemas.common import Grid
from sudoku_api.schemas.search import Contradiction

CellKind = Literal["empty", "given", "handwritten"]
Probability = Annotated[float, Field(ge=0, le=1)]
Point = Annotated[
    tuple[float, float], Field(description="`[x, y]` in pixels of the EXIF-oriented image")
]


class RecognizeImportForm(BaseModel):
    """`multipart/form-data` body of `POST /imports/recognize`."""

    file: UploadFile = Field(
        description="The photo: JPEG, PNG or WebP, at most 10 MB and 40 megapixels."
    )
    corners: str | None = Field(
        default=None,
        description=(
            "Optional manual grid corners overriding detection: a JSON array of four "
            "`[x, y]` pairs in the order top-left, top-right, bottom-right, bottom-left, in "
            "pixels of the EXIF-oriented image (the `corners` of a previous `RecognitionOut` "
            "has this shape). Example: `[[12,8],[980,15],[990,970],[5,960]]`. A malformed "
            "value returns 422 `validation_error`."
        ),
    )


class DigitAlternative(BaseModel):
    digit: Annotated[int, Field(ge=1, le=9)]
    p: Probability = Field(description="Model probability for this digit")


class ImageSize(BaseModel):
    width: Annotated[int, Field(ge=1)]
    height: Annotated[int, Field(ge=1)]


class CellReadingOut(BaseModel):
    index: Annotated[int, Field(ge=0, le=80)] = Field(description="Cell index, row-major")
    digit: Annotated[int, Field(ge=0, le=9)] = Field(description="0 = empty")
    kind: CellKind = Field(description="`given` = printed, `handwritten` = player's entry")
    confidence: Probability
    alternatives: Annotated[list[DigitAlternative], Field(max_length=3)] = Field(
        description="Top-3 candidates, best first (empty for empty cells)"
    )
    auto_corrected: bool = Field(
        description="True if constraint correction replaced the model's top digit (givens only)"
    )


class RecognitionOut(BaseModel):
    """What the photo shows. Never contains a solution."""

    corners: Annotated[list[Point], Field(min_length=4, max_length=4)] = Field(
        description="Detected (or supplied) grid corners: TL, TR, BR, BL"
    )
    image_size: ImageSize = Field(description="Size of the EXIF-oriented input image")
    cells: Annotated[list[CellReadingOut], Field(min_length=81, max_length=81)]
    grid_confidence: Probability
    warnings: list[str] = Field(description='Human-readable, e.g. "givens have multiple solutions"')


class ImportBoardIn(BaseModel):
    """The reviewed board. `current` must keep every given (422 `givens_modified`)."""

    givens: Grid = Field(description="Printed digits only, 0 = empty")
    current: Grid = Field(description="Givens plus handwritten entries, 0 = empty")


class ImportCheckOut(BaseModel):
    """Live feedback while reviewing. Deliberately has no `solution` field."""

    consistent: bool = Field(
        description="No duplicate digit in any row, column or box of `current`, and no cell "
        "without candidates"
    )
    contradiction: Contradiction | None = Field(
        description="The first constraint violation in `current` (null when consistent)"
    )
    solution_count: Literal[0, 1, 2] = Field(
        description="Solutions of the givens alone: 0, 1, or 2 meaning two or more"
    )
    difficulty: Difficulty | None = Field(
        description="Rated difficulty of the givens; null when not uniquely solvable or when "
        "the puzzle needs techniques beyond the rated set (shown as Unrated)"
    )
    rating_score: int | None = Field(
        description="Raw rating score of the givens; null when not uniquely solvable"
    )
