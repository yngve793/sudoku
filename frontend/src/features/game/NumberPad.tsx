import { DIGITS } from './grid'

interface NumberPadProps {
  counts: readonly number[]
  notesMode: boolean
  disabled: boolean
  /** Verb for the button labels (default "Enter", or "Toggle note" in notes mode). */
  verb?: string
  onDigit: (digit: number) => void
}

export function NumberPad({ counts, notesMode, disabled, verb, onDigit }: NumberPadProps) {
  const action = verb ?? (notesMode ? 'Toggle note' : 'Enter')
  return (
    <div className="numpad" role="group" aria-label={notesMode ? 'Note digits' : 'Digits'}>
      {DIGITS.map((d) => {
        const remaining = Math.max(0, 9 - (counts[d] ?? 0))
        return (
          <button
            key={d}
            type="button"
            className={`numpad__key${remaining === 0 ? ' numpad__key--done' : ''}`}
            disabled={disabled}
            aria-label={`${action} ${d}, ${remaining} left`}
            onClick={() => onDigit(d)}
          >
            <span className="numpad__digit">{d}</span>
            <span className="numpad__count" aria-hidden="true">
              {remaining === 0 ? '✓' : remaining}
            </span>
          </button>
        )
      })}
    </div>
  )
}
