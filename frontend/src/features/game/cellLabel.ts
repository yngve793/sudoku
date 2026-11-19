import { colOf, rowOf } from './grid'

export interface CellDescription {
  index: number
  value: number
  notes: readonly number[]
  given: boolean
  conflict: boolean
  wrong: boolean
  hinted: boolean
  /** Search mode: how the digit got onto the node's board. */
  searchOrigin?: 'choice' | 'manual' | 'auto' | null
  /** Search mode: part of the node's contradiction. */
  contradiction?: boolean
  step?: boolean
}

const ORIGIN_TEXT = { choice: 'guess', manual: 'placed', auto: 'implied' } as const

/** Screen-reader label, e.g. "Row 3, column 5, empty, notes 1 4". */
export function describeCell(p: CellDescription): string {
  const parts = [`Row ${rowOf(p.index) + 1}, column ${colOf(p.index) + 1}`]
  if (p.value) parts.push(p.given ? `${p.value}, given` : `${p.value}`)
  else if (p.notes.length) parts.push(`empty, notes ${p.notes.join(' ')}`)
  else parts.push('empty')
  if (p.value && p.searchOrigin) parts.push(ORIGIN_TEXT[p.searchOrigin])
  if (p.conflict) parts.push('conflict')
  if (p.contradiction) parts.push('contradiction')
  if (p.step) parts.push('viewed step')
  if (p.wrong) parts.push('incorrect')
  if (p.hinted) parts.push('hint')
  return parts.join(', ')
}
