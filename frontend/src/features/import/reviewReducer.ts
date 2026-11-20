/**
 * Pure state for the import review grid (PLAN.md §5.6): the player corrects the
 * recognised digits and their kind (printed given vs. handwritten entry) before
 * starting a game. Never solves anything; validation is server-side.
 */
import type { CellKind, CellReading, Recognition } from '../../api/types'
import type { Direction } from '../game/gameReducer'
import { CELL_COUNT, colOf, rowOf } from '../game/grid'

/** Readings below this confidence are highlighted for review. */
export const LOW_CONFIDENCE = 0.8

export interface ReviewCell {
  digit: number
  /** `empty` iff `digit === 0`. */
  kind: CellKind
}

export type ReviewView = 'all' | 'givens'

export interface ReviewState {
  cells: readonly ReviewCell[]
  /** What the recognition returned, for confidence and alternatives. */
  readings: readonly CellReading[]
  /** Cells the player edited or confirmed: no longer flagged. */
  reviewed: readonly boolean[]
  selected: number | null
  /** "Only givens" hides handwritten entries; editing there creates givens. */
  view: ReviewView
}

export type ReviewAction =
  | { type: 'load'; recognition: Recognition }
  | { type: 'select'; index: number | null }
  | { type: 'move'; direction: Direction }
  | { type: 'input'; digit: number; index?: number }
  | { type: 'erase'; index?: number }
  | { type: 'toggleKind'; index?: number }
  /** Accept the reading as is (clears the review flag). */
  | { type: 'confirm'; index?: number }
  | { type: 'setView'; view: ReviewView }
  | { type: 'reset' }

const EMPTY: ReviewCell = { digit: 0, kind: 'empty' }

export function createReviewState(recognition?: Recognition): ReviewState {
  const base: ReviewState = {
    cells: Array.from({ length: CELL_COUNT }, () => EMPTY),
    readings: [],
    reviewed: new Array<boolean>(CELL_COUNT).fill(false),
    selected: null,
    view: 'all',
  }
  return recognition ? reviewReducer(base, { type: 'load', recognition }) : base
}

function cellsFrom(readings: readonly CellReading[]): ReviewCell[] {
  const cells = Array.from({ length: CELL_COUNT }, () => EMPTY)
  for (const r of readings) {
    if (r.index < 0 || r.index >= CELL_COUNT) continue
    cells[r.index] =
      r.digit >= 1 && r.digit <= 9 && r.kind !== 'empty' ? { digit: r.digit, kind: r.kind } : EMPTY
  }
  return cells
}

function readingsByIndex(readings: readonly CellReading[]): CellReading[] {
  const out: CellReading[] = Array.from({ length: CELL_COUNT }, (_, index) => ({
    index,
    digit: 0,
    kind: 'empty',
    confidence: 1,
    alternatives: [],
    auto_corrected: false,
  }))
  for (const r of readings) if (r.index >= 0 && r.index < CELL_COUNT) out[r.index] = r
  return out
}

/** What the cell shows in the current view (handwritten entries hidden in "givens"). */
export function visibleCell(state: ReviewState, index: number): ReviewCell {
  const cell = state.cells[index] ?? EMPTY
  return state.view === 'givens' && cell.kind === 'handwritten' ? EMPTY : cell
}

/** Low confidence or auto-corrected, and not yet edited/confirmed by the player. */
export function needsReview(state: ReviewState, index: number): boolean {
  if (state.reviewed[index]) return false
  const r = state.readings[index]
  if (!r) return false
  return r.auto_corrected || r.confidence < LOW_CONFIDENCE
}

export function flaggedCells(state: ReviewState): number[] {
  return Array.from({ length: CELL_COUNT }, (_, i) => i).filter((i) => needsReview(state, i))
}

export function givensString(state: ReviewState): string {
  return state.cells.map((c) => (c.kind === 'given' ? c.digit : 0)).join('')
}

/** Givens plus handwritten entries (what the player has on paper). */
export function currentString(state: ReviewState): string {
  return state.cells.map((c) => c.digit).join('')
}

export function countKinds(state: ReviewState): { given: number; handwritten: number } {
  let given = 0
  let handwritten = 0
  for (const c of state.cells) {
    if (c.kind === 'given') given++
    else if (c.kind === 'handwritten') handwritten++
  }
  return { given, handwritten }
}

function target(state: ReviewState, index: number | undefined): number | null {
  const i = index ?? state.selected
  return i !== null && i >= 0 && i < CELL_COUNT ? i : null
}

function update(state: ReviewState, index: number, cell: ReviewCell): ReviewState {
  const cells = state.cells.slice()
  cells[index] = cell
  const reviewed = state.reviewed.slice()
  reviewed[index] = true
  return { ...state, cells, reviewed }
}

function move(state: ReviewState, direction: Direction): ReviewState {
  if (state.selected === null) return { ...state, selected: 0 }
  let row = rowOf(state.selected)
  let col = colOf(state.selected)
  if (direction === 'up') row = (row + 8) % 9
  else if (direction === 'down') row = (row + 1) % 9
  else if (direction === 'left') col = (col + 8) % 9
  else col = (col + 1) % 9
  return { ...state, selected: row * 9 + col }
}

/**
 * Kind for a digit typed into a cell: keep the cell's kind if it has one, else
 * the kind the model saw there, else `given` (a missed printed digit changes the
 * puzzle; a missed handwritten one does not, so givens are the safer default).
 */
function kindForInput(state: ReviewState, index: number): Exclude<CellKind, 'empty'> {
  if (state.view === 'givens') return 'given'
  const cell = state.cells[index] ?? EMPTY
  if (cell.kind !== 'empty') return cell.kind
  const read = state.readings[index]?.kind
  return read && read !== 'empty' ? read : 'given'
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'load':
      return {
        ...state,
        cells: cellsFrom(action.recognition.cells),
        readings: readingsByIndex(action.recognition.cells),
        reviewed: new Array<boolean>(CELL_COUNT).fill(false),
        selected: state.selected,
      }
    case 'reset':
      return {
        ...state,
        cells: cellsFrom(state.readings),
        reviewed: new Array<boolean>(CELL_COUNT).fill(false),
      }
    case 'select':
      return action.index === state.selected ? state : { ...state, selected: action.index }
    case 'move':
      return move(state, action.direction)
    case 'input': {
      const i = target(state, action.index)
      if (i === null || action.digit < 1 || action.digit > 9) return state
      return update(state, i, { digit: action.digit, kind: kindForInput(state, i) })
    }
    case 'erase': {
      const i = target(state, action.index)
      if (i === null) return state
      // In "only givens" a hidden handwritten entry stays; there is nothing visible to erase.
      if (
        visibleCell(state, i).kind === 'empty' &&
        state.cells[i]?.kind !== 'empty' &&
        state.view === 'givens'
      )
        return state
      return update(state, i, EMPTY)
    }
    case 'toggleKind': {
      const i = target(state, action.index)
      if (i === null) return state
      const cell = state.cells[i] ?? EMPTY
      if (cell.kind === 'empty') return state
      return update(state, i, {
        digit: cell.digit,
        kind: cell.kind === 'given' ? 'handwritten' : 'given',
      })
    }
    case 'confirm': {
      const i = target(state, action.index)
      if (i === null || state.reviewed[i]) return state
      const reviewed = state.reviewed.slice()
      reviewed[i] = true
      return { ...state, reviewed }
    }
    case 'setView':
      return action.view === state.view ? state : { ...state, view: action.view }
  }
}
