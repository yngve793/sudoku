import { describe, expect, it } from 'vitest'
import type { ImportCheck } from '../../api/types'
import { checkSummary, hasHandwrittenConflict, isReady } from './checkSummary'
import type { ImportCheckState } from './useImportCheck'

const conflict = {
  kind: 'duplicate' as const,
  cells: [2, 19],
  digit: 9,
  unit: 'box 1',
  explanation: '9 appears twice in box 1 (r1c3, r3c2).',
}

function state(result: Partial<ImportCheck> | null, stale = false): ImportCheckState {
  return {
    result: result && {
      consistent: true,
      contradiction: null,
      solution_count: 1,
      difficulty: 'medium',
      rating_score: 300,
      ...result,
    },
    stale,
    rateLimited: false,
    error: null,
  }
}

describe('Start gating', () => {
  it('allows valid givens, with or without a handwritten conflict', () => {
    expect(isReady(state({}))).toBe(true)
    expect(hasHandwrittenConflict(state({}))).toBe(false)
    const hand = state({ consistent: false, contradiction: conflict })
    expect(isReady(hand)).toBe(true)
    expect(hasHandwrittenConflict(hand)).toBe(true)
    // Unrated or rating timed out: still startable.
    expect(isReady(state({ difficulty: null, rating_score: null }))).toBe(true)
  })

  it('blocks givens that contradict (0 solutions) or are not unique', () => {
    const clash = state({ consistent: false, contradiction: conflict, solution_count: 0 })
    expect(isReady(clash)).toBe(false)
    expect(hasHandwrittenConflict(clash)).toBe(false)
    expect(isReady(state({ solution_count: 2, difficulty: null }))).toBe(false)
  })

  it('blocks stale or missing results', () => {
    expect(isReady(state({}, true))).toBe(false)
    expect(isReady(state(null))).toBe(false)
    expect(hasHandwrittenConflict(state({ consistent: false }, true))).toBe(false)
  })

  it('summarises for the live region', () => {
    expect(checkSummary(state({ consistent: false, contradiction: conflict }))).toBe(
      'Conflict: 9 appears twice in box 1 (r1c3, r3c2). Unique solution. Difficulty Medium. Ready to start.',
    )
    expect(checkSummary(state({ solution_count: 0, consistent: false }))).toMatch(
      /no solution\. Not ready to start yet\.$/,
    )
  })
})
