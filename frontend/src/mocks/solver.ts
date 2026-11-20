/**
 * Tiny bitmask backtracking solver for the MSW mocks (photo import). NOT used by
 * the app: the client never solves or counts solutions (PLAN.md §5.6).
 */
import { PEERS } from '../features/game/grid'

const ALL = 0x3fe // bits 1..9

function popcount(n: number): number {
  let c = 0
  for (let x = n; x; x &= x - 1) c++
  return c
}

/**
 * Counts solutions of `cells` (0 = empty), stopping at `limit`. A board whose
 * filled cells already clash has 0 solutions. Returns the first solution found.
 */
export function countSolutions(
  cells: readonly number[],
  limit = 2,
): { count: number; solution: number[] | null } {
  const board = cells.slice()
  for (let i = 0; i < 81; i++) {
    const v = board[i] ?? 0
    if (v && PEERS[i]!.some((p) => board[p] === v)) return { count: 0, solution: null }
  }
  let count = 0
  let first: number[] | null = null

  const candidatesOf = (i: number) => {
    let used = 0
    for (const p of PEERS[i]!) used |= 1 << (board[p] ?? 0)
    return ALL & ~used
  }

  const search = (): void => {
    // Most constrained empty cell first.
    let best = -1
    let bestMask = 0
    let bestCount = 10
    for (let i = 0; i < 81; i++) {
      if (board[i]) continue
      const mask = candidatesOf(i)
      const n = popcount(mask)
      if (n < bestCount) {
        best = i
        bestMask = mask
        bestCount = n
        if (n <= 1) break
      }
    }
    if (best < 0) {
      count++
      first ??= board.slice()
      return
    }
    for (let d = 1; d <= 9 && count < limit; d++) {
      if (!(bestMask & (1 << d))) continue
      board[best] = d
      search()
      board[best] = 0
    }
  }
  search()
  return { count: Math.min(count, limit), solution: first }
}
