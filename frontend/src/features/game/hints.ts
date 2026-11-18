import type { Game, HintStage } from '../../api/types'

export const STAGE_LABELS: Record<HintStage, string> = {
  1: 'Show technique and region',
  2: 'Highlight the cells',
  3: 'Reveal the value',
}

/** Points the next reveal will cost, as published by the server with the game. */
export function hintCost(game: Pick<Game, 'hint_costs'>, stage: HintStage): number {
  return game.hint_costs[stage]
}

export function nextStage(stage: HintStage | null): HintStage | null {
  if (stage === null) return 1
  if (stage === 1) return 2
  if (stage === 2) return 3
  return null
}
