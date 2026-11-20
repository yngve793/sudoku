# Labelled real photos

Put real phone photos of Sudoku puzzles here; the benchmark
(`uv run python vision/scripts/benchmark.py`) and the slow tests
(`cd vision && uv run pytest --run-slow`) pick them up automatically.

For each photo `NAME.jpg` (or `.jpeg`, `.png`, `.webp`) add `NAME.json`:

```json
{
  "givens":      "53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79",
  "handwritten": "..4.......................................................................1.......",
  "corners":     [[412.0, 388.5], [2950.0, 402.0], [2988.0, 2961.0], [380.0, 2930.0]]
}
```

- `givens`: the **printed** digits, 81 characters row by row; `.` or `0` for "no printed digit".
- `handwritten`: the **handwritten** entries in the same format; optional (default: none).
- `corners`: optional grid corners TL, TR, BR, BL in pixels of the photo **as displayed**
  (after EXIF rotation). When present, the benchmark also checks that the detected
  grid is within 5 % of the grid side.

Whitespace inside the grid strings is ignored, so rows may be written on separate lines
joined by spaces. Strip location metadata (GPS EXIF) before committing a photo, and keep
each one under 10 MB (the recognizer's limit).
