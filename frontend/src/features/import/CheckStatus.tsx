import { errorMessage } from '../../lib/errors'
import { difficultyLabel } from '../../lib/difficulties'
import { SOLUTIONS } from './checkSummary'
import type { ImportCheckState } from './useImportCheck'

/** Validation status of the reviewed board (from `POST /imports/check`). */
export function CheckStatus({ check }: { check: ImportCheckState }) {
  const r = check.result
  return (
    <div className="check-status" aria-busy={check.stale}>
      {check.rateLimited ? (
        <p className="check-status__line check-status__line--warn">
          <span aria-hidden="true">!</span> Too many checks in a short time; validation is paused
          and will retry shortly.
        </p>
      ) : check.error ? (
        <p className="check-status__line check-status__line--bad">
          <span aria-hidden="true">✕</span> Could not check the puzzle: {errorMessage(check.error)}
        </p>
      ) : null}
      {r ? (
        <ul className={`check-status__list${check.stale ? ' check-status__list--stale' : ''}`}>
          <li className={`check-status__line check-status__line--${r.consistent ? 'ok' : 'bad'}`}>
            <span aria-hidden="true">{r.consistent ? '✓' : '✕'}</span>{' '}
            {r.consistent ? 'No conflicts' : (r.contradiction?.explanation ?? 'Conflict')}
          </li>
          <li
            className={`check-status__line check-status__line--${r.solution_count === 1 ? 'ok' : 'bad'}`}
          >
            <span aria-hidden="true">{r.solution_count === 1 ? '✓' : '✕'}</span>{' '}
            {SOLUTIONS[r.solution_count]}
            {r.solution_count === 2 && ' (a printed digit may be missing or marked handwritten)'}
            {r.solution_count === 0 && ' (a printed digit is probably misread)'}
          </li>
          <li className="check-status__line">
            Difficulty:{' '}
            <strong>{r.solution_count === 1 ? difficultyLabel(r.difficulty) : '—'}</strong>
            {r.solution_count === 1 && r.difficulty === null && (
              <span className="check-status__aside"> (needs techniques beyond our rated set)</span>
            )}
          </li>
        </ul>
      ) : (
        !check.error && <p className="check-status__line">Checking the puzzle…</p>
      )}
      {r && check.stale && !check.rateLimited && (
        <p className="check-status__checking">Checking…</p>
      )}
    </div>
  )
}
