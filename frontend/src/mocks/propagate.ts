/**
 * Mock of `sudoku_validator.propagate` (PLAN.md §5.5): naked and hidden singles
 * repeated until nothing changes, stopping at the first contradiction.
 * Constraint-only; never looks at the solution.
 */
import type { Contradiction, PropagatePlacement } from '../api/types'
import { CELL_COUNT, DIGITS, UNITS } from '../features/game/grid'
import { candidates, findContradiction } from '../features/search/constraints'

export interface MockPropagation {
  placements: PropagatePlacement[]
  contradiction: Contradiction | null
  grid: number[]
}

function nextSingle(grid: readonly number[]): PropagatePlacement | null {
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if (grid[cell]) continue
    const options = candidates(grid, cell)
    if (options.length === 1) return { cell, value: options[0]!, technique: 'Naked Single' }
  }
  for (const unit of UNITS) {
    for (const digit of DIGITS) {
      if (unit.some((i) => grid[i] === digit)) continue
      const spots = unit.filter((i) => !grid[i] && candidates(grid, i).includes(digit))
      if (spots.length === 1) return { cell: spots[0]!, value: digit, technique: 'Hidden Single' }
    }
  }
  return null
}

export function mockPropagate(board: readonly number[], maxPlacements = 81): MockPropagation {
  const grid = board.slice()
  const placements: PropagatePlacement[] = []
  let contradiction = findContradiction(grid)
  while (!contradiction && placements.length < maxPlacements) {
    const step = nextSingle(grid)
    if (!step) break
    grid[step.cell] = step.value
    placements.push(step)
    contradiction = findContradiction(grid)
  }
  return { placements, contradiction, grid }
}
