import { DIFFICULTIES, type Difficulty } from '../../api/types'
import { DIFFICULTY_INFO } from '../../lib/difficulties'

interface DifficultyPickerProps {
  onPick: (difficulty: Difficulty) => void
  pending: Difficulty | null
  disabled?: boolean
}

export function DifficultyPicker({ onPick, pending, disabled = false }: DifficultyPickerProps) {
  return (
    <ul className="difficulty-list">
      {DIFFICULTIES.map((d, i) => {
        const info = DIFFICULTY_INFO[d]
        return (
          <li key={d}>
            <button
              type="button"
              className={`difficulty-card difficulty-card--${d}`}
              onClick={() => onPick(d)}
              disabled={disabled}
              aria-describedby={`difficulty-${d}-desc`}
            >
              <span className="difficulty-card__head">
                <span className="difficulty-card__name">{info.label}</span>
                <span className="difficulty-card__pips" aria-hidden="true">
                  {DIFFICULTIES.map((_, j) => (
                    <span key={j} className={j <= i ? 'pip pip--on' : 'pip'} />
                  ))}
                </span>
              </span>
              <span id={`difficulty-${d}-desc`} className="difficulty-card__body">
                <span className="difficulty-card__techniques">{info.techniques}</span>
                <span className="difficulty-card__desc">{info.description}</span>
              </span>
              {pending === d && <span className="difficulty-card__pending">Starting…</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
