import { describe, expect, it } from 'vitest'
import { IMPORT_GIVENS, IMPORT_SOLUTION } from './imports'
import { countSolutions } from './solver'

const cells = (grid: string) => [...grid].map(Number)

describe('mock solver', () => {
  it('finds the unique solution of the import puzzle', () => {
    const { count, solution } = countSolutions(cells(IMPORT_GIVENS))
    expect(count).toBe(1)
    expect(solution?.join('')).toBe(IMPORT_SOLUTION)
  })

  it('stops counting at the limit', () => {
    expect(countSolutions(cells('0'.repeat(81)), 2).count).toBe(2)
    expect(countSolutions(cells(IMPORT_GIVENS.slice(0, 27) + '0'.repeat(54)), 2).count).toBe(2)
  })

  it('returns 0 for clashing givens', () => {
    const dup = '55' + IMPORT_GIVENS.slice(2)
    expect(countSolutions(cells(dup))).toEqual({ count: 0, solution: null })
  })
})
