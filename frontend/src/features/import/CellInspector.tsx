import { cellName } from '../game/grid'
import { needsReview, type ReviewAction, type ReviewState } from './reviewReducer'

interface CellInspectorProps {
  state: ReviewState
  dispatch: (action: ReviewAction) => void
}

const pct = (p: number) => `${Math.round(p * 100)}%`

/** Details of the selected cell: what the model read, its alternatives and the kind. */
export function CellInspector({ state, dispatch }: CellInspectorProps) {
  const index = state.selected
  if (index === null)
    return (
      <div className="cell-inspector cell-inspector--empty">
        Select a cell to see what we read there and its alternatives.
      </div>
    )
  const cell = state.cells[index] ?? { digit: 0, kind: 'empty' }
  const reading = state.readings[index]
  const flagged = needsReview(state, index)
  const readDigit = reading?.digit ?? 0

  return (
    <section className="cell-inspector" aria-labelledby="inspector-title">
      <h3 id="inspector-title" className="cell-inspector__title">
        {cellName(index)}{' '}
        <span className="cell-inspector__now">
          {cell.digit ? `${cell.digit}, ${cell.kind}` : 'empty'}
        </span>
      </h3>
      {reading && (
        <p className="cell-inspector__read">
          Read as{' '}
          {readDigit ? (
            <>
              <strong>{readDigit}</strong> ({reading.kind}, {pct(reading.confidence)} sure)
            </>
          ) : (
            'empty'
          )}
          {flagged && !reading.auto_corrected && ' — please check'}
        </p>
      )}
      {reading?.auto_corrected && (
        <p className="cell-inspector__read">
          Auto-corrected: the photo looked more like a {reading.alternatives[0]?.digit ?? '?'}, but{' '}
          {readDigit} is the alternative that makes the printed digits fit together.
        </p>
      )}

      {reading && reading.alternatives.length > 0 && (
        <div className="cell-inspector__alts" role="group" aria-label="Alternatives">
          {reading.alternatives.map((alt) => (
            <button
              key={alt.digit}
              type="button"
              className="alt-button"
              aria-pressed={cell.digit === alt.digit}
              aria-label={`Use ${alt.digit} (${pct(alt.p)})`}
              onClick={() => dispatch({ type: 'input', digit: alt.digit, index })}
            >
              <span className="alt-button__digit">{alt.digit}</span>
              <span className="alt-button__p" aria-hidden="true">
                {pct(alt.p)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="cell-inspector__actions">
        {cell.kind !== 'empty' && (
          <fieldset className="segmented segmented--small">
            <legend className="visually-hidden">Kind of {cellName(index)}</legend>
            {(
              [
                ['given', 'Given (printed)'],
                ['handwritten', 'Handwritten'],
              ] as const
            ).map(([kind, label]) => (
              <label key={kind} className="segmented__option">
                <input
                  type="radio"
                  name="cell-kind"
                  value={kind}
                  checked={cell.kind === kind}
                  onChange={() => {
                    if (cell.kind !== kind) dispatch({ type: 'toggleKind', index })
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        )}
        {cell.digit !== 0 && (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => dispatch({ type: 'erase', index })}
          >
            Erase
          </button>
        )}
        {flagged && (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => dispatch({ type: 'confirm', index })}
          >
            Looks right
          </button>
        )}
      </div>
    </section>
  )
}
