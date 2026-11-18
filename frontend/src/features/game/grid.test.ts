import { describe, expect, it } from 'vitest'
import {
  PEERS,
  UNITS,
  boxOf,
  cellName,
  digitCounts,
  findConflicts,
  isFilled,
  parseGrid,
  parseNotes,
  serializeGrid,
  serializeNotes,
} from './grid'

describe('grid geometry', () => {
  it('has 27 units of 9 cells covering every cell 3 times', () => {
    expect(UNITS).toHaveLength(27)
    const counts = new Array<number>(81).fill(0)
    UNITS.flat().forEach((i) => counts[i]!++)
    expect(counts.every((c) => c === 3)).toBe(true)
  })

  it('gives every cell 20 peers, excluding itself', () => {
    PEERS.forEach((peers, i) => {
      expect(peers).toHaveLength(20)
      expect(peers).not.toContain(i)
    })
  })

  it('computes boxes and names', () => {
    expect(boxOf(0)).toBe(0)
    expect(boxOf(40)).toBe(4)
    expect(boxOf(80)).toBe(8)
    expect(cellName(0)).toBe('r1c1')
    expect(cellName(80)).toBe('r9c9')
  })
})

describe('serialization', () => {
  it('round-trips grids', () => {
    const text = '1'.repeat(40) + '0'.repeat(41)
    expect(serializeGrid(parseGrid(text))).toBe(text)
  })

  it.each(['', '1'.repeat(80), '.'.repeat(81), 'a'.repeat(81)])('rejects %j', (bad) => {
    expect(() => parseGrid(bad)).toThrow()
  })

  it('round-trips notes and omits empty cells', () => {
    const notes = parseNotes({ '0': [3, 1, 3], '80': [9] })
    expect(notes[0]).toEqual([1, 3])
    expect(serializeNotes(notes)).toEqual({ '0': [1, 3], '80': [9] })
    expect(parseNotes(null).every((n) => n.length === 0)).toBe(true)
  })
})

describe('analysis', () => {
  it('finds row, column and box conflicts', () => {
    const cells = new Array<number>(81).fill(0)
    cells[0] = 1
    cells[8] = 1 // row
    cells[72] = 2
    cells[9] = 2 // column 0
    cells[30] = 3
    cells[50] = 3 // box 4
    cells[80] = 4 // no conflict
    expect([...findConflicts(cells)].sort((a, b) => a - b)).toEqual([0, 8, 9, 30, 50, 72])
  })

  it('counts digits and detects filled boards', () => {
    const cells = new Array<number>(81).fill(5)
    expect(isFilled(cells)).toBe(true)
    expect(digitCounts(cells)[5]).toBe(81)
    cells[3] = 0
    expect(isFilled(cells)).toBe(false)
  })
})
