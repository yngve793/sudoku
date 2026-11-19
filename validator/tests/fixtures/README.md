# Test fixtures

## `contradictions.json`

Shared reference cases for the constraint-only contradiction check
(`sudoku_validator.find_contradiction`). The frontend reuses this file to keep
its TypeScript implementation in sync with the validator.

The file is a JSON array of objects:

| field      | type                        | meaning                                                   |
|------------|-----------------------------|-----------------------------------------------------------|
| `name`     | string                      | Short description of the case.                            |
| `grid`     | string, 81 chars `[0-9]`    | Board in row-major order, `0` = empty cell.               |
| `expected` | `Contradiction` or `null`   | The first contradiction found, or `null` if there is none. |

`Contradiction` is `{kind, cells, digit, unit, explanation}`:

- `kind`: `"duplicate"`, `"no_candidates"` or `"digit_nowhere"`.
- `cells`: cell indices 0-80, ascending — the cells holding the duplicated
  digit, the single empty cell, or every empty cell of the unit.
- `digit`: the digit for `duplicate` / `digit_nowhere`, `null` for `no_candidates`.
- `unit`: `"row N"`, `"column N"` or `"box N"` (1-based), `null` for `no_candidates`.
- `explanation`: human-readable text using `rXcY` cell names (implementations
  only need to match `kind`, `cells`, `digit` and `unit`; the text may differ).

Ordering (the first match wins): all `duplicate` checks, then `no_candidates`,
then `digit_nowhere`. Units are scanned rows 1-9, then columns 1-9, then boxes
1-9 (boxes numbered left to right, top to bottom); within a unit the lowest
digit wins. `no_candidates` scans cells in row-major order. Candidates are the
digits not placed in any peer (no further eliminations).

Do not edit the JSON by hand. The cases live in `../contradiction_cases.py`;
regenerate with:

    uv run python validator/tests/contradiction_cases.py
