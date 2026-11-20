import type { Difficulty, GameSource } from '../api/types'
import { difficultyLabel } from '../lib/difficulties'

interface GameBadgesProps {
  difficulty: Difficulty | null
  source?: GameSource
}

/** Level badge ("Unrated" for unrated imports) plus an "Imported" badge for photo imports. */
export function GameBadges({ difficulty, source }: GameBadgesProps) {
  return (
    <>
      <span className={`badge badge--level badge--${difficulty ?? 'unrated'}`}>
        {difficultyLabel(difficulty)}
      </span>
      {source === 'imported' && (
        <span className="badge badge--imported" title="Imported from a photo; not ranked">
          Imported
        </span>
      )}
    </>
  )
}
