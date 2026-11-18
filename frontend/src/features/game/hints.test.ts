import { describe, expect, it } from 'vitest'
import { hintCost, nextStage } from './hints'

describe('hints', () => {
  it('uses the costs the server sends with the game', () => {
    const game = { hint_costs: { 1: 10, 2: 20, 3: 40 } }
    expect(hintCost(game, 1)).toBe(10)
    expect(hintCost(game, 3)).toBe(40)
  })

  it('advances stages 1 -> 2 -> 3 -> done', () => {
    expect(nextStage(null)).toBe(1)
    expect(nextStage(1)).toBe(2)
    expect(nextStage(2)).toBe(3)
    expect(nextStage(3)).toBeNull()
  })
})
