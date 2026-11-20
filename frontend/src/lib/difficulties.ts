import type { Difficulty } from '../api/types'

export interface DifficultyInfo {
  label: string
  techniques: string
  description: string
}

/** Mirrors the technique ladder in PLAN.md §4. */
export const DIFFICULTY_INFO: Record<Difficulty, DifficultyInfo> = {
  beginner: {
    label: 'Beginner',
    techniques: 'Naked and hidden singles',
    description: 'Plenty of givens and the next move is always easy to spot.',
  },
  easy: {
    label: 'Easy',
    techniques: 'Naked and hidden singles',
    description: 'Same techniques as Beginner, with fewer obvious moves.',
  },
  medium: {
    label: 'Medium',
    techniques: 'Locked candidates, naked and hidden pairs',
    description: 'Start using pencil marks to narrow down candidates.',
  },
  hard: {
    label: 'Hard',
    techniques: 'Triples and X-Wing',
    description: 'Look for patterns across rows and columns.',
  },
  expert: {
    label: 'Expert',
    techniques: 'Quads, Swordfish, XY-Wing, XYZ-Wing',
    description: 'Larger subsets, fish and the first wing patterns.',
  },
  master: {
    label: 'Master',
    techniques: 'Jellyfish, coloring, X-Chains, W-Wing, Unique Rectangles',
    description: 'Chains of reasoning across the whole grid.',
  },
  extreme: {
    label: 'Extreme',
    techniques: 'XY-Chains, ALS-XZ, short forcing chains',
    description: 'The hardest puzzles that can still be solved without guessing.',
  },
}

/** Label for a possibly unrated difficulty (imported puzzles may be `null`). */
export function difficultyLabel(difficulty: Difficulty | null): string {
  return difficulty ? DIFFICULTY_INFO[difficulty].label : 'Unrated'
}
