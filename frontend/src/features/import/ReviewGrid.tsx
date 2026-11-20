import { useEffect, useRef, type KeyboardEvent } from 'react'
import { needsReview, visibleCell, type ReviewAction, type ReviewState } from './reviewReducer'
import { reviewKeyToAction } from './reviewKeyboard'
import { describeReviewCell, type CellFlags } from './reviewLabels'

interface ReviewGridProps {
  state: ReviewState
  /** Cells of the server-reported contradiction. */
  contradiction: ReadonlySet<number>
  dispatch: (action: ReviewAction) => void
}

const ROWS = Array.from({ length: 9 }, (_, r) => r)
const COLS = Array.from({ length: 9 }, (_, c) => c)

/** Editable 9×9 review grid: digits plus kind (given vs. handwritten). */
export function ReviewGrid({ state, contradiction, dispatch }: ReviewGridProps) {
  const cellEls = useRef<(HTMLDivElement | null)[]>([])
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state.selected === null) return
    const active = document.activeElement
    if (gridRef.current?.contains(active) && active !== cellEls.current[state.selected])
      cellEls.current[state.selected]?.focus()
  }, [state.selected])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const action = reviewKeyToAction(event)
    if (!action) return
    event.preventDefault()
    if (state.selected === null && action.type !== 'move') dispatch({ type: 'select', index: 0 })
    dispatch(action)
  }

  return (
    // Keys are handled once for the whole grid (roving tabindex on the cells).
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      ref={gridRef}
      role="grid"
      aria-label="Recognised puzzle"
      aria-describedby="review-keys"
      className={`board review-grid${state.view === 'givens' ? ' review-grid--givens' : ''}`}
      onKeyDown={onKeyDown}
    >
      {ROWS.map((r) => (
        <div role="row" className="board__row" key={r}>
          {COLS.map((c) => {
            const i = r * 9 + c
            const cell = visibleCell(state, i)
            const reading = state.readings[i]
            const flagged = needsReview(state, i)
            const flags: CellFlags = {
              autoCorrected: flagged && (reading?.auto_corrected ?? false),
              uncertain: flagged && !(reading?.auto_corrected ?? false),
              contradiction: contradiction.has(i),
            }
            const selected = state.selected === i
            const className = [
              'cell',
              cell.kind === 'given'
                ? 'cell--given'
                : cell.kind === 'handwritten'
                  ? 'cell--user cell--handwritten'
                  : 'cell--empty',
              selected && 'cell--selected',
              flags.uncertain && 'cell--uncertain',
              flags.autoCorrected && 'cell--autocorrected',
              flags.contradiction && 'cell--contradiction',
              c % 3 === 2 && c !== 8 && 'cell--box-right',
              r % 3 === 2 && r !== 8 && 'cell--box-bottom',
            ]
              .filter(Boolean)
              .join(' ')
            const tabbable = state.selected === null ? i === 0 : selected
            return (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <div
                key={i}
                ref={(el) => {
                  cellEls.current[i] = el
                }}
                role="gridcell"
                className={className}
                tabIndex={tabbable ? 0 : -1}
                aria-selected={selected}
                aria-label={describeReviewCell(i, cell, flags)}
                data-index={i}
                onClick={() => dispatch({ type: 'select', index: i })}
                onFocus={() => {
                  if (!selected) dispatch({ type: 'select', index: i })
                }}
              >
                {cell.digit ? (
                  <span className="cell__value" aria-hidden="true">
                    {cell.digit}
                  </span>
                ) : null}
                {cell.kind === 'handwritten' && (
                  <span className="cell__kind" aria-hidden="true">
                    ✎
                  </span>
                )}
                {(flags.uncertain || flags.autoCorrected) && (
                  <span className="cell__review" aria-hidden="true">
                    {flags.autoCorrected ? 'A' : '?'}
                  </span>
                )}
                {flags.contradiction && (
                  <span className="cell__flag" aria-hidden="true">
                    ✕
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
