import { difficultyLabel } from '../../lib/difficulties'
import type { ImportCheckState } from './useImportCheck'

/**
 * Start needs valid givens: exactly one solution (which implies the givens are
 * consistent; contradicting givens count 0). Conflicting handwritten entries
 * don't block: `/games/import` accepts them and the board shows the conflict.
 */
export function isReady(check: ImportCheckState): boolean {
  const r = check.result
  return !check.stale && r !== null && r.solution_count === 1
}

/** Givens are fine, but `current` (with handwritten entries) has a conflict. */
export function hasHandwrittenConflict(check: ImportCheckState): boolean {
  return isReady(check) && check.result?.consistent === false
}

export const HANDWRITTEN_CONFLICT_WARNING =
  'Your handwritten entries contain a conflict. You can fix it now or after starting.'

export const SOLUTIONS = {
  0: 'The printed digits have no solution',
  1: 'Unique solution',
  2: 'The printed digits have more than one solution',
} as const

/** One sentence for the live region. */
export function checkSummary(check: ImportCheckState): string {
  const r = check.result
  if (check.rateLimited) return 'Checking paused for a moment.'
  if (!r) return ''
  const parts = [
    r.consistent
      ? 'No conflicts'
      : `Conflict: ${r.contradiction?.explanation ?? 'check the marked cells'}`,
    SOLUTIONS[r.solution_count],
  ]
  if (r.solution_count === 1) parts.push(`Difficulty ${difficultyLabel(r.difficulty)}`)
  // The handwritten-conflict warning has its own status region next to Start.
  parts.push(isReady(check) ? 'Ready to start.' : 'Not ready to start yet.')
  return parts.join('. ').replace(/\.\./g, '.')
}
