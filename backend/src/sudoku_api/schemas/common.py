from __future__ import annotations

from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints

GRID_PATTERN = r"^[0-9]{81}$"

Grid = Annotated[str, StringConstraints(pattern=GRID_PATTERN, min_length=81, max_length=81)]


def _normalize_notes(value: dict[str, list[int]]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for key, digits in value.items():
        if not key.isdigit() or not 0 <= int(key) <= 80 or key != str(int(key)):
            raise ValueError(f"note key {key!r} must be a cell index 0-80")
        if any(not 1 <= d <= 9 for d in digits):
            raise ValueError(f"notes for cell {key} must be digits 1-9")
        if digits:
            out[key] = sorted(set(digits))
    return out


Notes = Annotated[dict[str, list[int]], AfterValidator(_normalize_notes)]


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ErrorOut(BaseModel):
    detail: str
    code: str


class MessageOut(BaseModel):
    message: str


def error_responses(*codes: int) -> dict[int | str, dict[str, Any]]:
    """OpenAPI `responses=` entries using the shared error model."""
    descriptions = {
        400: "Bad request",
        401: "Not authenticated",
        403: "Forbidden",
        404: "Not found",
        409: "Conflict",
        413: "Payload too large",
        415: "Unsupported media type",
        422: "Validation error",
        429: "Rate limited",
        503: "Service unavailable",
    }
    return {c: {"model": ErrorOut, "description": descriptions.get(c, "Error")} for c in codes}
