import { describe, expect, it } from 'vitest'
import type { CellReading, Recognition } from '../../api/types'
import { mockRecognition } from '../../mocks/imports'
import { reviewKeyToAction } from './reviewKeyboard'
import {
  countKinds,
  createReviewState,
  currentString,
  flaggedCells,
  givensString,
  needsReview,
  reviewReducer,
  visibleCell,
  type ReviewAction,
  type ReviewState,
} from './reviewReducer'

function reading(index: number, over: Partial<CellReading> = {}): CellReading {
  return {
    index,
    digit: 0,
    kind: 'empty',
    confidence: 0.99,
    alternatives: [],
    auto_corrected: false,
    ...over,
  }
}

/** r1c1 given 5, r1c2 handwritten 3 (low confidence), r1c3 given 7 (auto-corrected). */
function recognition(): Recognition {
  const cells = Array.from({ length: 81 }, (_, i) => reading(i))
  cells[0] = reading(0, { digit: 5, kind: 'given', alternatives: [{ digit: 5, p: 0.99 }] })
  cells[1] = reading(1, {
    digit: 3,
    kind: 'handwritten',
    confidence: 0.6,
    alternatives: [
      { digit: 3, p: 0.6 },
      { digit: 8, p: 0.35 },
    ],
  })
  cells[2] = reading(2, {
    digit: 7,
    kind: 'given',
    confidence: 0.45,
    auto_corrected: true,
    alternatives: [
      { digit: 1, p: 0.5 },
      { digit: 7, p: 0.45 },
    ],
  })
  cells[3] = reading(3, { confidence: 0.5 }) // empty but unsure
  return {
    corners: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    image_size: { width: 10, height: 10 },
    cells,
    grid_confidence: 0.9,
    warnings: [],
  }
}

const run = (state: ReviewState, ...actions: ReviewAction[]) => actions.reduce(reviewReducer, state)
const tail = '0'.repeat(77)

describe('reviewReducer', () => {
  it('loads digits and kinds from the recognition', () => {
    const s = createReviewState(recognition())
    expect(givensString(s)).toBe('5070' + tail)
    expect(currentString(s)).toBe('5370' + tail)
    expect(countKinds(s)).toEqual({ given: 2, handwritten: 1 })
    expect(s.selected).toBeNull()
    expect(s.view).toBe('all')
  })

  it('treats inconsistent readings defensively (out-of-range index, digit 0 with a kind)', () => {
    const r = recognition()
    r.cells[4] = reading(4, { digit: 0, kind: 'given' })
    r.cells.push(reading(99, { digit: 4, kind: 'given' }))
    const s = createReviewState(r)
    expect(visibleCell(s, 4)).toEqual({ digit: 0, kind: 'empty' })
    expect(s.cells).toHaveLength(81)
  })

  it('flags low-confidence and auto-corrected cells until edited or confirmed', () => {
    let s = createReviewState(recognition())
    expect(flaggedCells(s)).toEqual([1, 2, 3])
    s = run(s, { type: 'input', digit: 8, index: 1 })
    expect(needsReview(s, 1)).toBe(false)
    s = run(s, { type: 'select', index: 2 }, { type: 'confirm' })
    expect(flaggedCells(s)).toEqual([3])
    // Confirming twice is a no-op (same object).
    expect(reviewReducer(s, { type: 'confirm', index: 2 })).toBe(s)
    s = run(s, { type: 'reset' })
    expect(flaggedCells(s)).toEqual([1, 2, 3])
    expect(currentString(s)).toBe('5370' + tail)
  })

  it('input keeps the cell kind, else the read kind, else given', () => {
    let s = createReviewState(recognition())
    s = run(s, { type: 'input', digit: 8, index: 1 })
    expect(s.cells[1]).toEqual({ digit: 8, kind: 'handwritten' })
    s = run(s, { type: 'input', digit: 9, index: 10 })
    expect(s.cells[10]).toEqual({ digit: 9, kind: 'given' })
    const r = recognition()
    r.cells[20] = reading(20, { digit: 4, kind: 'handwritten' })
    s = createReviewState(r)
    s = run(s, { type: 'erase', index: 20 }, { type: 'input', digit: 6, index: 20 })
    expect(s.cells[20]).toEqual({ digit: 6, kind: 'handwritten' })
  })

  it('ignores input without a target or with an invalid digit', () => {
    const s = createReviewState(recognition())
    expect(run(s, { type: 'input', digit: 4 })).toBe(s)
    expect(run(s, { type: 'input', digit: 0, index: 5 })).toBe(s)
    expect(run(s, { type: 'input', digit: 10, index: 5 })).toBe(s)
    expect(run(s, { type: 'erase' })).toBe(s)
    expect(run(s, { type: 'toggleKind' })).toBe(s)
  })

  it('toggles given ↔ handwritten, never on empty cells', () => {
    let s = createReviewState(recognition())
    s = run(s, { type: 'select', index: 0 }, { type: 'toggleKind' })
    expect(s.cells[0]).toEqual({ digit: 5, kind: 'handwritten' })
    expect(givensString(s).startsWith('0070')).toBe(true)
    expect(currentString(s).startsWith('5370')).toBe(true)
    s = run(s, { type: 'toggleKind' })
    expect(s.cells[0]).toEqual({ digit: 5, kind: 'given' })
    expect(run(s, { type: 'toggleKind', index: 40 })).toBe(s)
  })

  it('erases to empty', () => {
    const s = run(createReviewState(recognition()), { type: 'erase', index: 0 })
    expect(s.cells[0]).toEqual({ digit: 0, kind: 'empty' })
    expect(givensString(s)).toBe('0070' + tail)
  })

  it('"only givens" hides handwritten entries; typing there makes givens', () => {
    let s = run(createReviewState(recognition()), { type: 'setView', view: 'givens' })
    expect(visibleCell(s, 1)).toEqual({ digit: 0, kind: 'empty' })
    // The hidden entry is still part of `current` …
    expect(currentString(s)).toBe('5370' + tail)
    // … and erasing a hidden entry does nothing.
    expect(run(s, { type: 'erase', index: 1 })).toBe(s)
    s = run(s, { type: 'input', digit: 2, index: 1 })
    expect(s.cells[1]).toEqual({ digit: 2, kind: 'given' })
    expect(run(s, { type: 'setView', view: 'givens' })).toBe(s)
  })

  it('moves the selection with wrap-around like the game board', () => {
    let s = createReviewState(recognition())
    s = run(s, { type: 'move', direction: 'right' })
    expect(s.selected).toBe(0)
    s = run(s, { type: 'move', direction: 'left' })
    expect(s.selected).toBe(8)
    s = run(s, { type: 'move', direction: 'up' })
    expect(s.selected).toBe(80)
    s = run(s, { type: 'move', direction: 'down' }, { type: 'move', direction: 'right' })
    expect(s.selected).toBe(0)
    expect(run(s, { type: 'select', index: 0 })).toBe(s)
  })

  it('reload (re-detect) replaces cells and flags but keeps the selection', () => {
    let s = run(createReviewState(recognition()), { type: 'select', index: 7 })
    s = run(s, { type: 'input', digit: 1, index: 7 })
    s = run(s, { type: 'load', recognition: mockRecognition(100, 100, null) })
    expect(s.selected).toBe(7)
    expect(s.cells[7]).toEqual({ digit: 0, kind: 'empty' })
    expect(flaggedCells(s).length).toBeGreaterThan(0)
  })
})

describe('reviewKeyToAction', () => {
  const key = (k: string, code = '', extra: Partial<KeyboardEvent> = {}) =>
    reviewKeyToAction({
      key: k,
      code,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...extra,
    })

  it('maps board keys plus T and Enter', () => {
    expect(key('ArrowLeft')).toEqual({ type: 'move', direction: 'left' })
    expect(key('4', 'Digit4')).toEqual({ type: 'input', digit: 4 })
    expect(key('$', 'Digit4', { shiftKey: true })).toEqual({ type: 'input', digit: 4 })
    expect(key('Backspace')).toEqual({ type: 'erase' })
    expect(key('Delete')).toEqual({ type: 'erase' })
    expect(key('t')).toEqual({ type: 'toggleKind' })
    expect(key('T', 'KeyT', { shiftKey: true })).toEqual({ type: 'toggleKind' })
    expect(key('Enter')).toEqual({ type: 'confirm' })
  })

  it('ignores modifiers and board-only shortcuts', () => {
    expect(key('t', 'KeyT', { ctrlKey: true })).toBeNull()
    expect(key('4', 'Digit4', { altKey: true })).toBeNull()
    expect(key('n')).toBeNull()
    expect(key('h')).toBeNull()
    expect(key('x')).toBeNull()
  })
})
