import type { Hint, HintStage } from '../../api/types'
import { cellName } from './grid'
import { STAGE_LABELS, nextStage } from './hints'

interface HintPanelProps {
  hint: Hint | null
  pending: boolean
  error: string | null
  costOf: (stage: HintStage) => number
  onReveal: (stage: HintStage) => void
  onApply: (index: number, value: number) => void
  onClose: () => void
}

export function HintPanel({
  hint,
  pending,
  error,
  costOf,
  onReveal,
  onApply,
  onClose,
}: HintPanelProps) {
  const stage = hint?.stage ?? null
  const upcoming = nextStage(stage)
  // When a value is revealed, the server lists the target cell first.
  const target = hint?.value != null ? hint.cells[0] : undefined

  return (
    <section className="hint-panel" aria-labelledby="hint-title" aria-live="polite">
      <header className="hint-panel__header">
        <h2 id="hint-title" className="hint-panel__title">
          Hint
        </h2>
        <ol className="hint-steps" aria-label="Hint progress">
          {([1, 2, 3] as const).map((s) => (
            <li
              key={s}
              className={`hint-steps__dot${stage !== null && s <= stage ? ' hint-steps__dot--done' : ''}`}
              aria-current={s === stage ? 'step' : undefined}
            >
              <span className="visually-hidden">
                Stage {s}: {STAGE_LABELS[s]}
                {stage !== null && s <= stage ? ' (revealed)' : ''}
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close hint">
          ✕
        </button>
      </header>

      {hint ? (
        <div className="hint-panel__body">
          <p className="hint-panel__kind">
            {hint.kind === 'error' ? (
              <span className="badge badge--error">Mistake found</span>
            ) : (
              hint.technique && <span className="badge badge--accent">{hint.technique}</span>
            )}
          </p>
          <p className="hint-panel__explanation">{hint.explanation}</p>
          {hint.value !== null && (
            <p className="hint-panel__value">
              Value: <strong>{hint.value}</strong>
              {target !== undefined && <> in {cellName(target)}</>}
            </p>
          )}
          {hint.cells.length > 0 && hint.stage > 1 && (
            <p className="hint-panel__cells">Highlighted: {hint.cells.map(cellName).join(', ')}</p>
          )}
        </div>
      ) : (
        <p className="hint-panel__body">
          Hints come in three stages. Each reveal costs points, shown before you reveal it.
        </p>
      )}

      {error && (
        <p className="hint-panel__error" role="alert">
          {error}
        </p>
      )}

      <div className="hint-panel__actions">
        {upcoming !== null ? (
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            onClick={() => onReveal(upcoming)}
          >
            {pending ? 'Thinking…' : `${STAGE_LABELS[upcoming]} (−${costOf(upcoming)} points)`}
          </button>
        ) : (
          target !== undefined &&
          hint?.value != null && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => onApply(target, hint.value ?? 0)}
            >
              Fill in {hint.value} at {cellName(target)}
            </button>
          )
        )}
      </div>
    </section>
  )
}
