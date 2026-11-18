import { colOf, rowOf } from './grid'

export interface CellDescription {
  index: number
  value: number
  notes: readonly number[]
  given: boolean
  conflict: boolean
  wrong: boolean
  hinted: boolean
}

/** Screen-reader label, e.g. "Row 3, column 5, empty, notes 1 4". */
export function describeCell(p: CellDescription): string {
  const parts = [`Row ${rowOf(p.index) + 1}, column ${colOf(p.index) + 1}`]
  if (p.value) parts.push(p.given ? `${p.value}, given` : `${p.value}`)
  else if (p.notes.length) parts.push(`empty, notes ${p.notes.join(' ')}`)
  else parts.push('empty')
  if (p.conflict) parts.push('conflict')
  if (p.wrong) parts.push('incorrect')
  if (p.hinted) parts.push('hint')
  return parts.join(', ')
}
