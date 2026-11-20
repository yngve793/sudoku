/**
 * Photo-import fakes for the MSW mocks (PLAN.md §5.6). The mock "recognises"
 * every image as the same well-known puzzle, with realistic imperfections:
 * handwritten entries, low-confidence readings, one auto-corrected given and one
 * misread handwritten digit that contradicts a given (so the review screen has
 * something to fix). Tests can force errors with `simulateImportError`.
 */
import type { CellReading, Corner, Difficulty, Recognition } from '../api/types'

/** A classic puzzle with exactly one solution (30 givens). */
export const IMPORT_GIVENS =
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079'
export const IMPORT_SOLUTION =
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179'

/** Handwritten entries the "photo" shows: cell -> digit as read (the solution unless noted). */
export const HANDWRITTEN_READ: Readonly<Record<number, number>> = {
  2: 9, // misread: really a 4; 9 clashes with the given 9 at r3c2 (box 1)
  3: 6,
  10: 7,
  11: 2,
  18: 1,
  21: 3,
}
/** The misread handwritten cell and its true digit. */
export const MISREAD_CELL = 2
export const MISREAD_TRUE_DIGIT = 4
/** A given whose top model guess was replaced by constraint correction. */
export const AUTO_CORRECTED_CELL = 4
/** Low-confidence (< 0.8) readings: cell -> [confidence, alternatives best first]. */
const LOW_CONFIDENCE: Readonly<Record<number, readonly [number, readonly [number, number][]]>> = {
  0: [
    0.74,
    [
      [5, 0.74],
      [6, 0.22],
      [8, 0.04],
    ],
  ],
  2: [
    0.58,
    [
      [9, 0.58],
      [4, 0.38],
      [7, 0.04],
    ],
  ],
  11: [
    0.71,
    [
      [2, 0.71],
      [7, 0.2],
      [1, 0.09],
    ],
  ],
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_PIXELS = 40_000_000

// ---------- error simulation (tests and manual dev) ----------

export type ImportEndpoint = 'recognize' | 'check' | 'import'
export interface SimulatedError {
  status: number
  code: string
  detail?: string
}

const simulated = new Map<ImportEndpoint, SimulatedError>()

/**
 * Makes the next calls to `endpoint` fail with `error` (until cleared with
 * `null`). In the browser mock you can also set
 * `localStorage['sudoku.mock.importError.recognize'] = '{"status":503,"code":"recognition_unavailable"}'`.
 */
export function simulateImportError(endpoint: ImportEndpoint, error: SimulatedError | null): void {
  if (error) simulated.set(endpoint, error)
  else simulated.delete(endpoint)
}

export function resetImportSimulation(): void {
  simulated.clear()
}

export function simulatedError(endpoint: ImportEndpoint): SimulatedError | null {
  const set = simulated.get(endpoint)
  if (set) return set
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`sudoku.mock.importError.${endpoint}`)
    return raw ? (JSON.parse(raw) as SimulatedError) : null
  } catch {
    return null
  }
}

// ---------- image sniffing (magic bytes + dimensions, like the backend's decoder) ----------

export type Sniffed =
  | { ok: true; width: number; height: number }
  | { ok: false; code: 'unsupported_image' | 'image_unreadable' | 'image_too_large' }

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    const length = (b[i + 2]! << 8) | b[i + 3]!
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! }
    i += 2 + length
  }
  return null
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = String.fromCharCode(...b.slice(12, 16))
  if (chunk === 'VP8X' && b.length >= 30)
    return {
      width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
      height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
    }
  if (chunk === 'VP8 ' && b.length >= 30)
    return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

export function sniffImage(bytes: Uint8Array): Sniffed {
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, code: 'image_too_large' }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to))
  let size: { width: number; height: number } | null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) size = jpegSize(bytes)
  else if (ascii(1, 4) === 'PNG' && bytes[0] === 0x89 && bytes.length >= 24)
    size = {
      width: new DataView(bytes.buffer, bytes.byteOffset).getUint32(16),
      height: new DataView(bytes.buffer, bytes.byteOffset).getUint32(20),
    }
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') size = webpSize(bytes)
  else return { ok: false, code: 'unsupported_image' }
  if (!size || size.width < 1 || size.height < 1) return { ok: false, code: 'image_unreadable' }
  if (size.width * size.height > MAX_PIXELS) return { ok: false, code: 'image_too_large' }
  return { ok: true, ...size }
}

// ---------- recognition ----------

/** Detected corners: the grid fills the middle of the photo with a little perspective. */
export function detectedCorners(width: number, height: number): Corner[] {
  const side = Math.min(width, height) * 0.8
  const x0 = (width - side) / 2
  const y0 = (height - side) / 2
  const skew = side * 0.03
  const r = (v: number) => Math.round(v * 10) / 10
  return [
    [r(x0 + skew), r(y0)],
    [r(x0 + side - skew), r(y0 + skew)],
    [r(x0 + side), r(y0 + side)],
    [r(x0), r(y0 + side - skew)],
  ]
}

/** Twice the signed polygon area (shoelace); |value| / 2 is the area. */
export function polygonArea(corners: readonly Corner[]): number {
  let sum = 0
  corners.forEach(([x1, y1], i) => {
    const [x2, y2] = corners[(i + 1) % corners.length]!
    sum += x1 * y2 - x2 * y1
  })
  return Math.abs(sum) / 2
}

function reading(index: number): CellReading {
  const given = Number(IMPORT_GIVENS[index])
  const handwritten = HANDWRITTEN_READ[index]
  const digit = given || (handwritten ?? 0)
  if (!digit)
    return {
      index,
      digit: 0,
      kind: 'empty',
      confidence: 0.99,
      alternatives: [],
      auto_corrected: false,
    }
  const kind = given ? 'given' : 'handwritten'
  if (index === AUTO_CORRECTED_CELL)
    // The model preferred 1; constraint correction picked its second choice.
    return {
      index,
      digit,
      kind,
      confidence: 0.46,
      alternatives: [
        { digit: 1, p: 0.51 },
        { digit, p: 0.46 },
        { digit: 4, p: 0.03 },
      ],
      auto_corrected: true,
    }
  const low = LOW_CONFIDENCE[index]
  if (low)
    return {
      index,
      digit,
      kind,
      confidence: low[0],
      alternatives: low[1].map(([d, p]) => ({ digit: d, p })),
      auto_corrected: false,
    }
  const confidence = kind === 'given' ? 0.99 : 0.95
  const other = (digit % 9) + 1
  return {
    index,
    digit,
    kind,
    confidence,
    alternatives: [
      { digit, p: confidence },
      { digit: other, p: Math.round((1 - confidence) * 100) / 100 },
    ],
    auto_corrected: false,
  }
}

export function mockRecognition(
  width: number,
  height: number,
  corners: readonly Corner[] | null,
): Recognition {
  return {
    corners: corners ? corners.map(([x, y]) => [x, y] as Corner) : detectedCorners(width, height),
    image_size: { width, height },
    cells: Array.from({ length: 81 }, (_, i) => reading(i)),
    grid_confidence: corners ? 0.9 : 0.93,
    warnings: ['A handwritten digit contradicts a printed given.'],
  }
}

/**
 * Parses the `corners` form field like the backend: a JSON array of four
 * `[x, y]` number pairs. Returns an error message for a 422.
 */
export function parseCornersField(raw: string): Corner[] | string {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return 'corners: Value error, corners must be a JSON array of four [x, y] pairs'
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        p.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0),
    )
  )
    return 'corners: Value error, corners must be a JSON array of four [x, y] pairs'
  return (value as [number, number][]).map(([x, y]) => [x, y])
}

// ---------- rating (mock heuristic: the real backend uses the validator's rate()) ----------

export function mockRating(givens: string): { difficulty: Difficulty | null; score: number } {
  const clues = [...givens].filter((c) => c !== '0').length
  const score = (81 - clues) * 12
  if (clues >= 36) return { difficulty: 'easy', score }
  if (clues >= 30) return { difficulty: 'medium', score }
  if (clues >= 26) return { difficulty: 'hard', score }
  return { difficulty: null, score }
}
