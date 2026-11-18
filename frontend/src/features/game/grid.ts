import type { NotesWire } from '../../api/types'

/** 81 values, row-major, 0 = empty. */
export type Cells = readonly number[]
/** 81 sorted candidate lists. */
export type Notes = readonly (readonly number[])[]

export const SIZE = 9
export const CELL_COUNT = 81
export const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export const rowOf = (index: number) => Math.floor(index / SIZE)
export const colOf = (index: number) => index % SIZE
export const boxOf = (index: number) =>
  Math.floor(rowOf(index) / 3) * 3 + Math.floor(colOf(index) / 3)
export const indexOf = (row: number, col: number) => row * SIZE + col

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/** The 27 units: 9 rows, 9 columns, 9 boxes. */
export const UNITS: readonly (readonly number[])[] = [
  ...range(9).map((r) => range(9).map((c) => indexOf(r, c))),
  ...range(9).map((c) => range(9).map((r) => indexOf(r, c))),
  ...range(9).map((b) =>
    range(9).map((i) => indexOf(Math.floor(b / 3) * 3 + Math.floor(i / 3), (b % 3) * 3 + (i % 3))),
  ),
]

/** For each cell, the 20 other cells sharing its row, column or box. */
export const PEERS: readonly (readonly number[])[] = range(CELL_COUNT).map((i) => {
  const set = new Set<number>()
  for (const unit of UNITS) if (unit.includes(i)) unit.forEach((j) => set.add(j))
  set.delete(i)
  return [...set].sort((a, b) => a - b)
})

const GRID_RE = /^[0-9]{81}$/

export function parseGrid(text: string): number[] {
  if (!GRID_RE.test(text)) throw new Error('Grid must be 81 digits')
  return [...text].map(Number)
}

export function serializeGrid(cells: Cells): string {
  return cells.join('')
}

export function emptyNotes(): number[][] {
  return range(CELL_COUNT).map(() => [])
}

export function parseNotes(wire: NotesWire | null | undefined): number[][] {
  const notes = emptyNotes()
  if (!wire) return notes
  for (const [key, digits] of Object.entries(wire)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT) continue
    notes[index] = [...new Set(digits.filter((d) => d >= 1 && d <= 9))].sort((a, b) => a - b)
  }
  return notes
}

export function serializeNotes(notes: Notes): NotesWire {
  const wire: NotesWire = {}
  notes.forEach((digits, index) => {
    if (digits.length) wire[String(index)] = [...digits]
  })
  return wire
}

/** Indices of filled cells whose value repeats somewhere in one of their units. */
export function findConflicts(cells: Cells): Set<number> {
  const conflicts = new Set<number>()
  for (const unit of UNITS) {
    const seen = new Map<number, number[]>()
    for (const i of unit) {
      const v = cells[i] ?? 0
      if (!v) continue
      const list = seen.get(v)
      if (list) list.push(i)
      else seen.set(v, [i])
    }
    for (const list of seen.values()) if (list.length > 1) list.forEach((i) => conflicts.add(i))
  }
  return conflicts
}

export function isFilled(cells: Cells): boolean {
  return cells.every((v) => v !== 0)
}

/** How many times each digit 1–9 is placed (index 0 unused). */
export function digitCounts(cells: Cells): number[] {
  const counts = new Array<number>(10).fill(0)
  for (const v of cells) if (v) counts[v] = (counts[v] ?? 0) + 1
  return counts
}

export function cellName(index: number): string {
  return `r${rowOf(index) + 1}c${colOf(index) + 1}`
}
