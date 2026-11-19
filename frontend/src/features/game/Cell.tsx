import { memo } from 'react'
import { describeCell } from './cellLabel'
import { DIGITS, colOf, rowOf } from './grid'

export interface CellProps {
  index: number
  value: number
  notes: readonly number[]
  given: boolean
  selected: boolean
  /** Roving tabindex: the one cell reachable with Tab. */
  tabbable: boolean
  peer: boolean
  sameDigit: boolean
  conflict: boolean
  wrong: boolean
  hinted: boolean
  searchOrigin?: 'choice' | 'manual' | 'auto' | null
  /** The search origin belongs to the selected node itself (not an ancestor). */
  searchOwn?: boolean
  contradiction?: boolean
  /** Search: the graph step currently viewed placed this cell. */
  step?: boolean
  onSelect: (index: number) => void
  cellRef: (index: number, el: HTMLDivElement | null) => void
}

function CellImpl(props: CellProps) {
  const { index, value, notes, given, selected, peer, sameDigit, conflict, wrong, hinted } = props
  const { searchOrigin, contradiction = false } = props
  const row = rowOf(index)
  const col = colOf(index)
  const className = [
    'cell',
    given ? 'cell--given' : value ? 'cell--user' : 'cell--empty',
    selected && 'cell--selected',
    peer && 'cell--peer',
    sameDigit && 'cell--same',
    conflict && 'cell--conflict',
    wrong && 'cell--wrong',
    hinted && 'cell--hint',
    value !== 0 && searchOrigin && `cell--${searchOrigin}`,
    value !== 0 && searchOrigin && props.searchOwn && 'cell--own',
    contradiction && 'cell--contradiction',
    props.step && 'cell--step',
    col % 3 === 2 && col !== 8 && 'cell--box-right',
    row % 3 === 2 && row !== 8 && 'cell--box-bottom',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    // Keyboard input is handled once at document level (see GameSession), not per cell.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
    <div
      ref={(el) => props.cellRef(index, el)}
      role="gridcell"
      className={className}
      tabIndex={props.tabbable ? 0 : -1}
      aria-selected={selected}
      aria-readonly={given || undefined}
      aria-label={describeCell(props)}
      data-index={index}
      onClick={() => props.onSelect(index)}
      onFocus={() => {
        if (!selected) props.onSelect(index)
      }}
    >
      {value ? (
        <span className="cell__value" aria-hidden="true">
          {value}
        </span>
      ) : notes.length ? (
        <span className="cell__notes" aria-hidden="true">
          {DIGITS.map((d) => (
            <span key={d} className="cell__note">
              {notes.includes(d) ? d : ''}
            </span>
          ))}
        </span>
      ) : null}
      {(conflict || wrong || contradiction) && (
        <span className="cell__flag" aria-hidden="true">
          {wrong || contradiction ? '✕' : '!'}
        </span>
      )}
    </div>
  )
}

export const Cell = memo(CellImpl)
