import { colOf, rowOf } from '../game/grid'
import type { ReviewCell } from './reviewReducer'

export interface CellFlags {
  uncertain: boolean
  autoCorrected: boolean
  contradiction: boolean
}

/** e.g. "Row 1, column 3, 9, handwritten, low confidence, contradiction". */
export function describeReviewCell(index: number, cell: ReviewCell, flags: CellFlags): string {
  const parts = [`Row ${rowOf(index) + 1}, column ${colOf(index) + 1}`]
  parts.push(cell.digit ? `${cell.digit}, ${cell.kind}` : 'empty')
  if (flags.autoCorrected) parts.push('auto-corrected, please check')
  else if (flags.uncertain) parts.push('low confidence, please check')
  if (flags.contradiction) parts.push('contradiction')
  return parts.join(', ')
}
