/**
 * Constraint-only checks for search mode, with the same semantics and ordering
 * as `sudoku_validator.find_contradiction` (PLAN.md §5.5). Never consults the
 * solution.
 *
 * Order: every `duplicate` first, then `no_candidates`, then `digit_nowhere`.
 * Units are checked rows → columns → boxes, each in ascending order, and
 * digits ascending within a unit. Unit names are 1-based ("row 3").
 */
import type { Contradiction } from '../../api/types'
import { CELL_COUNT, DIGITS, PEERS, UNITS, cellName, type Cells } from '../game/grid'

/** "row 3" / "column 5" / "box 2" for UNITS[index] (rows, then columns, then boxes). */
export function unitName(unitIndex: number): string {
  const kind = unitIndex < 9 ? 'row' : unitIndex < 18 ? 'column' : 'box'
  return `${kind} ${(unitIndex % 9) + 1}`
}

/** Digits not used by any peer of an empty `cell`; `[]` if the cell is filled. */
export function candidates(board: Cells, cell: number): number[] {
  if (cell < 0 || cell >= CELL_COUNT || (board[cell] ?? 0) !== 0) return []
  const used = new Set<number>()
  for (const peer of PEERS[cell] ?? []) {
    const v = board[peer] ?? 0
    if (v) used.add(v)
  }
  return DIGITS.filter((d) => !used.has(d))
}

const COUNT_WORDS = ['', 'once', 'twice', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

function timesText(n: number): string {
  return n <= 2 ? (COUNT_WORDS[n] ?? '') : `${COUNT_WORDS[n] ?? n} times`
}

function findDuplicate(board: Cells): Contradiction | null {
  for (let u = 0; u < UNITS.length; u++) {
    const unit = UNITS[u] ?? []
    for (const digit of DIGITS) {
      const cells = unit.filter((i) => board[i] === digit).sort((a, b) => a - b)
      if (cells.length > 1) {
        const name = unitName(u)
        return {
          kind: 'duplicate',
          cells,
          digit,
          unit: name,
          explanation: `${digit} appears ${timesText(cells.length)} in ${name} (${cells.map(cellName).join(', ')}).`,
        }
      }
    }
  }
  return null
}

function findNoCandidates(board: Cells): Contradiction | null {
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if ((board[cell] ?? 0) === 0 && candidates(board, cell).length === 0) {
      return {
        kind: 'no_candidates',
        cells: [cell],
        digit: null,
        unit: null,
        explanation: `No digit can go in ${cellName(cell)}: every digit from 1 to 9 already appears in its row, column or box.`,
      }
    }
  }
  return null
}

function findDigitNowhere(board: Cells): Contradiction | null {
  for (let u = 0; u < UNITS.length; u++) {
    const unit = UNITS[u] ?? []
    const empty = unit.filter((i) => (board[i] ?? 0) === 0).sort((a, b) => a - b)
    if (!empty.length) continue
    const present = new Set(unit.map((i) => board[i] ?? 0))
    for (const digit of DIGITS) {
      if (present.has(digit)) continue
      if (!empty.some((i) => candidates(board, i).includes(digit))) {
        const name = unitName(u)
        return {
          kind: 'digit_nowhere',
          cells: empty,
          digit,
          unit: name,
          explanation: `${digit} cannot be placed anywhere in ${name}: it is missing there, but every empty cell of ${name} already sees a ${digit}.`,
        }
      }
    }
  }
  return null
}

/** The first contradiction on `board`, or `null` if it is still consistent. */
export function findContradiction(board: Cells): Contradiction | null {
  return findDuplicate(board) ?? findNoCandidates(board) ?? findDigitNowhere(board)
}
