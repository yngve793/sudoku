"""Photo import (PLAN.md §5.6): recognise a photographed grid and check the reviewed board."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Form

from sudoku_api.deps import CurrentUserDep, PuzzleGeneratorDep, SettingsDep
from sudoku_api.ratelimit import import_check_rate_limit
from sudoku_api.schemas.common import error_responses
from sudoku_api.schemas.imports import (
    CellKind,
    CellReadingOut,
    DigitAlternative,
    ImageSize,
    ImportBoardIn,
    ImportCheckOut,
    RecognitionOut,
    RecognizeImportForm,
)
from sudoku_api.schemas.search import Contradiction
from sudoku_api.services import imports as import_service
from sudoku_api.services import recognition
from sudoku_api.uploads import limited_upload_route

router = APIRouter(prefix="/imports", tags=["imports"], responses=error_responses(401, 422))

# The upload endpoint gets a route class that rate-limits, checks for credentials and bounds
# the body *before* it is read (see `sudoku_api.uploads`).
upload_router = APIRouter(
    prefix="/imports",
    tags=["imports"],
    responses=error_responses(401, 422),
    route_class=limited_upload_route("import", lambda s: s.import_rate_limit),
)


def _clamp(p: float) -> float:
    return min(1.0, max(0.0, float(p)))


@upload_router.post(
    "/recognize",
    response_model=RecognitionOut,
    responses=error_responses(413, 415, 429, 503),
    summary="Recognise a Sudoku grid (printed givens and handwritten entries) in a photo",
    description=(
        "Multipart upload. The photo is processed in memory and never stored or logged. "
        "Error codes: 413 `image_too_large` (over 10 MB or 40 MP); 415 `unsupported_image` "
        "(not JPEG/PNG/WebP); 422 `image_unreadable`, `no_grid_found` or `validation_error` "
        "(e.g. malformed `corners`); 429 `rate_limited` (`IMPORT_RATE_LIMIT`); "
        "503 `recognition_unavailable` (timeout or worker failure)."
    ),
)
async def recognize(
    form: Annotated[RecognizeImportForm, Form(media_type="multipart/form-data")],
    user: CurrentUserDep,
    runner: PuzzleGeneratorDep,
    settings: SettingsDep,
) -> RecognitionOut:
    corners = recognition.parse_corners(form.corners)
    image = await form.file.read()
    result = await recognition.recognize(
        runner, image, corners, settings.recognition_timeout_seconds
    )
    del image
    return RecognitionOut(
        corners=list(result.corners),
        image_size=ImageSize(width=result.image_size[0], height=result.image_size[1]),
        cells=[
            CellReadingOut(
                index=c.index,
                digit=c.digit,
                kind=cast(CellKind, c.kind),
                confidence=_clamp(c.confidence),
                alternatives=[
                    DigitAlternative(digit=d, p=_clamp(p))
                    for d, p in c.alternatives[:3]
                    if 1 <= d <= 9 and c.kind != "empty"  # contract: empty cells have none
                ],
                auto_corrected=c.auto_corrected,
            )
            for c in result.cells
        ],
        grid_confidence=_clamp(result.grid_confidence),
        warnings=list(result.warnings),
    )


@router.post(
    "/check",
    response_model=ImportCheckOut,
    responses=error_responses(429),
    dependencies=[Depends(import_check_rate_limit)],
    summary="Live check of a reviewed board: consistency, solution count and rating",
    description=(
        "Never returns the solution. `solution_count` and the rating use the givens only; "
        "`consistent`/`contradiction` use `current`. Error codes: 422 `givens_modified` "
        "(`current` changes a given) or `validation_error`; 429 `rate_limited`."
    ),
)
async def check(
    body: ImportBoardIn,
    user: CurrentUserDep,
    runner: PuzzleGeneratorDep,
    settings: SettingsDep,
) -> ImportCheckOut:
    result = await import_service.check_board(
        runner, body.givens, body.current, settings.import_rating_timeout_seconds
    )
    c = result.contradiction
    return ImportCheckOut(
        consistent=c is None,
        contradiction=None
        if c is None
        else Contradiction(
            kind=c.kind, cells=list(c.cells), digit=c.digit, unit=c.unit, explanation=c.explanation
        ),
        solution_count=result.solution_count,
        difficulty=result.difficulty,
        rating_score=result.rating_score,
    )
