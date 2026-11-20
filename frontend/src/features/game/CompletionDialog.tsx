import { useRef } from 'react'
import { Link } from 'react-router'
import type { Difficulty, GameSource, ScoreBreakdown } from '../../api/types'
import { Modal } from '../../components/Modal'
import { DIFFICULTY_INFO, difficultyLabel } from '../../lib/difficulties'
import { formatDuration, formatNumber } from '../../lib/format'

interface CompletionDialogProps {
  /** `null` for an unrated imported puzzle. */
  difficulty: Difficulty | null
  source: GameSource
  score: number
  elapsedSeconds: number
  hintsUsed: number
  mistakes: number
  /** Server-computed breakdown; absent when reopening an already-completed game. */
  breakdown: ScoreBreakdown | null
  starting: boolean
  onPlayAgain: (difficulty: Difficulty) => void
  onClose: () => void
}

export function CompletionDialog(props: CompletionDialogProps) {
  const primary = useRef<HTMLButtonElement>(null)
  const { difficulty } = props
  const imported = props.source === 'imported'
  return (
    <Modal title="Puzzle solved!" onClose={props.onClose} initialFocusRef={primary}>
      <div className="completion">
        <p className="completion__difficulty">
          {difficultyLabel(difficulty)}
          {imported && ' · Imported'}
        </p>
        <p className="completion__score">
          <span className="completion__score-value">{formatNumber(props.score)}</span>
          <span className="completion__score-label">points</span>
        </p>
        <dl className="completion__stats">
          <div>
            <dt>Time</dt>
            <dd>{formatDuration(props.elapsedSeconds)}</dd>
          </div>
          <div>
            <dt>Hints</dt>
            <dd>{props.hintsUsed}</dd>
          </div>
          <div>
            <dt>Mistakes</dt>
            <dd>{props.mistakes}</dd>
          </div>
        </dl>
        {props.breakdown && <Breakdown breakdown={props.breakdown} />}
        {imported && (
          <p className="completion__note">
            Imported games count towards your stats but are not ranked.
          </p>
        )}
        <div className="completion__actions">
          {difficulty && !imported ? (
            <>
              <button
                ref={primary}
                type="button"
                className="button button--primary"
                onClick={() => props.onPlayAgain(difficulty)}
                disabled={props.starting}
              >
                {props.starting ? 'Starting…' : `New ${DIFFICULTY_INFO[difficulty].label} game`}
              </button>
              <Link
                className="button button--secondary"
                to={`/leaderboard?difficulty=${difficulty}`}
              >
                View leaderboard
              </Link>
            </>
          ) : (
            <>
              <Link className="button button--primary" to="/import">
                Import another photo
              </Link>
              <Link className="button button--secondary" to="/">
                New game
              </Link>
            </>
          )}
          <button type="button" className="button button--ghost" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Breakdown({ breakdown: b }: { breakdown: ScoreBreakdown }) {
  const timed = Math.round(b.base * b.time_factor)
  return (
    <table className="breakdown">
      <caption className="visually-hidden">Score breakdown</caption>
      <tbody>
        <tr>
          <th scope="row">Base</th>
          <td>{formatNumber(b.base)}</td>
        </tr>
        <tr>
          <th scope="row">
            Time bonus ×{b.time_factor.toFixed(2)}{' '}
            <span className="breakdown__note">(par {formatDuration(b.par_seconds)})</span>
          </th>
          <td>{formatNumber(timed)}</td>
        </tr>
        <tr>
          <th scope="row">Hints</th>
          <td>−{formatNumber(b.hint_penalty)}</td>
        </tr>
        <tr>
          <th scope="row">Mistakes</th>
          <td>−{formatNumber(b.mistake_penalty)}</td>
        </tr>
        <tr>
          <th scope="row">
            Search <span className="breakdown__note">(auto placements)</span>
          </th>
          <td>−{formatNumber(b.search_penalty)}</td>
        </tr>
        <tr className="breakdown__total">
          <th scope="row">Total</th>
          <td>{formatNumber(b.total)}</td>
        </tr>
      </tbody>
    </table>
  )
}
