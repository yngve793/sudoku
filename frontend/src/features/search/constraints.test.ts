import { describe, expect, it } from 'vitest'
import type { Contradiction } from '../../api/types'
import { parseGrid } from '../game/grid'
import { candidates, findContradiction, unitName } from './constraints'

export const SOLVED =
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179'

function grid(entries: Record<number, number>, base = '0'.repeat(81)): number[] {
  const cells = parseGrid(base)
  for (const [i, v] of Object.entries(entries)) cells[Number(i)] = v
  return cells
}

describe('unitName', () => {
  it('names rows, columns and boxes 1-based', () => {
    expect(unitName(0)).toBe('row 1')
    expect(unitName(8)).toBe('row 9')
    expect(unitName(9)).toBe('column 1')
    expect(unitName(20)).toBe('box 3')
  })
})

describe('candidates', () => {
  it('returns every digit on an empty board', () => {
    expect(candidates(grid({}), 40)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('excludes digits in the row, column and box only', () => {
    // r1c2 = 1 (row), r9c1 = 2 (column), r2c2 = 3 (box), r5c5 = 4 (not a peer)
    const board = grid({ 1: 1, 72: 2, 10: 3, 40: 4 })
    expect(candidates(board, 0)).toEqual([4, 5, 6, 7, 8, 9])
  })

  it('returns [] for a filled cell or an out-of-range index', () => {
    expect(candidates(parseGrid(SOLVED), 0)).toEqual([])
    expect(candidates(grid({}), -1)).toEqual([])
    expect(candidates(grid({}), 81)).toEqual([])
  })
})

describe('findContradiction', () => {
  it('returns null for an empty, solved or merely incomplete board', () => {
    expect(findContradiction(grid({}))).toBeNull()
    expect(findContradiction(parseGrid(SOLVED))).toBeNull()
    const partial = parseGrid(SOLVED)
    partial[0] = 0
    partial[40] = 0
    expect(findContradiction(partial)).toBeNull()
  })

  it('finds a duplicate in a row with all its cells', () => {
    expect(findContradiction(grid({ 0: 5, 8: 5 }))).toEqual<Contradiction>({
      kind: 'duplicate',
      cells: [0, 8],
      digit: 5,
      unit: 'row 1',
      explanation: '5 appears twice in row 1 (r1c1, r1c9).',
    })
  })

  it('says "three times" for a triple', () => {
    const c = findContradiction(grid({ 72: 8, 76: 8, 80: 8 }))
    expect(c?.cells).toEqual([72, 76, 80])
    expect(c?.explanation).toBe('8 appears three times in row 9 (r9c1, r9c5, r9c9).')
  })

  it('reports rows before columns before boxes, lowest digit first', () => {
    // column 1 duplicate (r1c1, r9c1) and row 5 duplicate: the row wins.
    const c = findContradiction(grid({ 0: 3, 72: 3, 38: 6, 43: 6 }))
    expect(c?.unit).toBe('row 5')
    // Two duplicates in the same row: the lower digit wins.
    expect(findContradiction(grid({ 19: 4, 26: 4, 20: 2, 25: 2 }))?.digit).toBe(2)
    // Column before box.
    expect(findContradiction(grid({ 30: 3, 50: 3, 12: 7, 66: 7 }))?.unit).toBe('column 4')
    expect(findContradiction(grid({ 30: 3, 50: 3 }))?.unit).toBe('box 5')
  })

  it('finds an empty cell without candidates (before digit_nowhere)', () => {
    // Row 1 holds 1..8 in c2..c9, column 1 holds 9: r1c1 has no candidate.
    const board = grid({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9 })
    expect(findContradiction(board)).toEqual<Contradiction>({
      kind: 'no_candidates',
      cells: [0],
      digit: null,
      unit: null,
      explanation:
        'No digit can go in r1c1: every digit from 1 to 9 already appears in its row, column or box.',
    })
  })

  it('finds a digit that fits nowhere in a unit, listing the unit empty cells', () => {
    // Row 1: c4..c9 = 1 2 3 4 6 7, c1..c3 empty; a 5 in box 1 (r2c1) blocks them all.
    const board = grid({ 3: 1, 4: 2, 5: 3, 6: 4, 7: 6, 8: 7, 9: 5 })
    expect(findContradiction(board)).toEqual<Contradiction>({
      kind: 'digit_nowhere',
      cells: [0, 1, 2],
      digit: 5,
      unit: 'row 1',
      explanation:
        '5 cannot be placed anywhere in row 1: it is missing there, but every empty cell of row 1 already sees a 5.',
    })
  })
})

// ---------- parity with the validator's shared fixture ----------

interface FixtureCase {
  name: string
  grid: string
  expected: Contradiction | null
}

// Read-only, via a relative path; empty if the validator has not written it.
const fixtureFiles = import.meta.glob<FixtureCase[]>(
  '../../../../validator/tests/fixtures/contradictions.json',
  { eager: true, import: 'default' },
)
const fixtureCases = Object.values(fixtureFiles)[0] ?? []

describe('validator fixture parity (validator/tests/fixtures/contradictions.json)', () => {
  it('the fixture is present', () => {
    expect(fixtureCases.length).toBeGreaterThan(0)
  })

  it.each(fixtureCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const actual = findContradiction(parseGrid(c.grid))
    if (c.expected === null) {
      expect(actual).toBeNull()
      return
    }
    // kind/cells/digit/unit must match exactly; the text is checked too because
    // we deliberately use the validator's wording.
    expect(actual).toEqual(c.expected)
  })
})
