import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { gamesApi, importsApi } from '../../api/endpoints'
import type { Corner, Recognition } from '../../api/types'
import { Alert } from '../../components/Alert'
import { difficultyLabel } from '../../lib/difficulties'
import { digitCounts } from '../game/grid'
import { NumberPad } from '../game/NumberPad'
import { currentGameQueryKey } from '../game/useStartGame'
import { CheckStatus } from './CheckStatus'
import {
  HANDWRITTEN_CONFLICT_WARNING,
  checkSummary,
  hasHandwrittenConflict,
  isReady,
} from './checkSummary'
import { CornerEditor } from './CornerEditor'
import { CellInspector } from './CellInspector'
import { startErrorMessage } from './importErrors'
import { useImportFlow, type ImportSession } from './importSession'
import { ReviewGrid } from './ReviewGrid'
import {
  countKinds,
  createReviewState,
  currentString,
  flaggedCells,
  givensString,
  reviewReducer,
  visibleCell,
} from './reviewReducer'
import { UploadProgress } from './UploadProgress'
import { useImportCheck } from './useImportCheck'
import { useRecognize } from './useRecognize'

const sameCorners = (a: readonly Corner[], b: readonly Corner[]) =>
  JSON.stringify(a) === JSON.stringify(b)

export function ImportReviewPage() {
  const { session, updateRecognition } = useImportFlow()
  if (!session) return <Navigate to="/import" replace />
  return <Review session={session} onRecognition={updateRecognition} />
}

function Review({
  session,
  onRecognition,
}: {
  session: ImportSession
  onRecognition: (r: Recognition) => void
}) {
  const { recognition, photo, photoUrl } = session
  const [state, dispatch] = useReducer(reviewReducer, recognition, createReviewState)
  const [corners, setCorners] = useState<Corner[]>(() => recognition.corners.map((c) => [...c]))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const redetect = useRecognize()

  // A new recognition (re-detect) replaces the grid and the corners.
  const loaded = useRef(recognition)
  useEffect(() => {
    if (loaded.current === recognition) return
    loaded.current = recognition
    dispatch({ type: 'load', recognition })
    setCorners(recognition.corners.map((c) => [...c]))
  }, [recognition])

  const givens = givensString(state)
  const current = currentString(state)
  const check = useImportCheck(givens, current)
  const ready = isReady(check)
  const contradiction = useMemo(
    () => new Set(check.result?.contradiction?.cells ?? []),
    [check.result],
  )
  const flagged = flaggedCells(state)
  const kinds = countKinds(state)
  const counts = useMemo(
    () => digitCounts(state.cells.map((_, i) => visibleCell(state, i).digit)),
    [state],
  )

  const currentGame = useQuery({ queryKey: currentGameQueryKey, queryFn: gamesApi.current })
  const start = useMutation({
    mutationFn: () => importsApi.start({ givens, current }),
    onSuccess: (game) => {
      queryClient.setQueryData(currentGameQueryKey, game)
      void queryClient.invalidateQueries({ queryKey: ['scores'] })
      void navigate(`/game/${game.id}`, { replace: true })
    },
  })

  const cornersChanged = !sameCorners(corners, recognition.corners)

  async function onRedetect() {
    const result = await redetect.run(photo.blob, corners)
    if (result) onRecognition(result)
  }

  function nextFlagged() {
    if (!flagged.length) return
    const after = flagged.find((i) => i > (state.selected ?? -1)) ?? flagged[0]
    if (after === undefined) return
    dispatch({ type: 'select', index: after })
    document.querySelector<HTMLElement>(`.review-grid [data-index="${after}"]`)?.focus()
  }

  const blocker = ready
    ? null
    : check.result && !check.stale
      ? 'Fix the problems above to start.'
      : 'Waiting for the check to finish.'

  return (
    <div className="page import-review">
      <header className="page__header">
        <h1 className="page__title">Check the puzzle</h1>
        <p className="page__lead">
          Compare the grid with your photo and fix anything we misread. Printed digits become the
          puzzle; handwritten ones become your entries.
        </p>
      </header>

      {recognition.warnings.length > 0 && (
        <Alert tone="warning" title="Have a close look">
          <ul className="plain-list">
            {recognition.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="import-review__layout">
        <section className="import-review__photo" aria-labelledby="photo-title">
          <h2 id="photo-title" className="section-title">
            Your photo
          </h2>
          <CornerEditor
            photoUrl={photoUrl}
            size={recognition.image_size}
            corners={corners}
            onChange={setCorners}
            disabled={redetect.busy}
          />
          <div className="import-review__photo-actions">
            {redetect.busy ? (
              <UploadProgress
                preparing={false}
                phase={redetect.phase}
                onCancel={redetect.cancel}
                readingText="Re-reading the grid…"
              />
            ) : (
              <>
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={!cornersChanged}
                  aria-describedby="redetect-note"
                  onClick={() => void onRedetect()}
                >
                  Re-detect
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={!cornersChanged}
                  onClick={() => setCorners(recognition.corners.map((c) => [...c]))}
                >
                  Reset corners
                </button>
              </>
            )}
            <p id="redetect-note" className="import-review__note">
              Re-detect reads the grid again inside the corners and replaces your corrections.
            </p>
          </div>
          {redetect.phase.kind === 'error' && (
            <Alert tone={redetect.phase.cancelled ? 'info' : 'error'}>
              {redetect.phase.message}
            </Alert>
          )}
        </section>

        <section className="import-review__grid" aria-labelledby="grid-title">
          <div className="import-review__grid-head">
            <h2 id="grid-title" className="section-title">
              What we read
            </h2>
            <fieldset className="segmented segmented--small">
              <legend className="visually-hidden">Show</legend>
              {(
                [
                  ['all', 'Givens + handwritten'],
                  ['givens', 'Only givens'],
                ] as const
              ).map(([view, label]) => (
                <label key={view} className="segmented__option">
                  <input
                    type="radio"
                    name="review-view"
                    value={view}
                    checked={state.view === view}
                    onChange={() => dispatch({ type: 'setView', view })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
          </div>

          <CheckStatus check={check} />

          <ReviewGrid state={state} contradiction={contradiction} dispatch={dispatch} />

          <p className="import-review__counts">
            {kinds.given} given{kinds.given === 1 ? '' : 's'} · {kinds.handwritten} handwritten
            {flagged.length > 0 ? (
              <>
                {' · '}
                <button type="button" className="link-button" onClick={nextFlagged}>
                  {flagged.length} cell{flagged.length === 1 ? '' : 's'} to check
                </button>
              </>
            ) : (
              ' · nothing flagged'
            )}
          </p>

          <CellInspector state={state} dispatch={dispatch} />

          <NumberPad
            counts={counts}
            notesMode={false}
            verb="Enter"
            disabled={state.selected === null}
            onDigit={(digit) => dispatch({ type: 'input', digit })}
          />

          <ul className="review-legend" aria-label="Legend">
            <li>
              <span className="review-legend__given">7</span> printed given
            </li>
            <li>
              <span className="review-legend__hand">7</span>
              <span aria-hidden="true">✎</span> handwritten
            </li>
            <li>
              <span className="review-legend__mark">?</span> low confidence
            </li>
            <li>
              <span className="review-legend__mark">A</span> auto-corrected
            </li>
            <li>
              <span className="review-legend__mark review-legend__mark--bad">✕</span> conflict
            </li>
          </ul>

          <p id="review-keys" className="game__keys import-review__keys">
            <kbd>←↑→↓</kbd> move · <kbd>1–9</kbd> enter · <kbd>⌫</kbd> erase · <kbd>T</kbd>{' '}
            given/handwritten · <kbd>Enter</kbd> looks right
          </p>

          <div className="import-review__start">
            {currentGame.data && (
              <p className="import-review__note">
                Starting abandons your current {difficultyLabel(currentGame.data.difficulty)} game.
              </p>
            )}
            {hasHandwrittenConflict(check) && (
              <Alert tone="warning">{HANDWRITTEN_CONFLICT_WARNING}</Alert>
            )}
            {start.isError && <Alert tone="error">{startErrorMessage(start.error)}</Alert>}
            <button
              type="button"
              className="button button--primary button--large"
              disabled={!ready || start.isPending}
              aria-describedby={blocker ? 'start-blocker' : undefined}
              onClick={() => start.mutate()}
            >
              {start.isPending ? 'Starting…' : 'Start game'}
            </button>
            {blocker && (
              <p id="start-blocker" className="import-review__note">
                {blocker}
              </p>
            )}
            <p className="import-review__note">
              Imported games aren&apos;t ranked on the leaderboard.{' '}
              <Link to="/import">Use a different photo</Link>
            </p>
          </div>
        </section>
      </div>

      <div className="visually-hidden" aria-live="polite">
        {check.stale ? '' : checkSummary(check)}
      </div>
    </div>
  )
}
