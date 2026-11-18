import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Cell } from './Cell'
import type { GameState } from './gameReducer'
import { PEERS, findConflicts } from './grid'

interface BoardProps {
  state: GameState
  onSelect: (index: number) => void
  /** Hide digits (paused). */
  hidden?: boolean
  label?: string
}

const ROWS = Array.from({ length: 9 }, (_, r) => r)
const COLS = Array.from({ length: 9 }, (_, c) => c)

export function Board({ state, onSelect, hidden = false, label = 'Sudoku board' }: BoardProps) {
  const cellEls = useRef<(HTMLDivElement | null)[]>([])
  const gridRef = useRef<HTMLDivElement>(null)
  const conflicts = useMemo(() => findConflicts(state.cells), [state.cells])
  const wrong = useMemo(() => new Set(state.wrongCells), [state.wrongCells])
  const hinted = useMemo(() => new Set(state.hintCells), [state.hintCells])
  const peers = useMemo(
    () => new Set(state.selected === null ? [] : PEERS[state.selected]),
    [state.selected],
  )
  const selectedValue = state.selected === null ? 0 : (state.cells[state.selected] ?? 0)

  const cellRef = useCallback((index: number, el: HTMLDivElement | null) => {
    cellEls.current[index] = el
  }, [])

  // Keep DOM focus on the selected cell while the user is navigating the grid.
  useEffect(() => {
    if (state.selected === null) return
    const active = document.activeElement
    const navigating = active === document.body || gridRef.current?.contains(active)
    if (navigating && active !== cellEls.current[state.selected]) {
      cellEls.current[state.selected]?.focus()
    }
  }, [state.selected])

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label={label}
      aria-readonly={state.locked || undefined}
      className={`board${hidden ? ' board--hidden' : ''}${state.notesMode ? ' board--notes' : ''}`}
    >
      {ROWS.map((r) => (
        <div role="row" className="board__row" key={r}>
          {COLS.map((c) => {
            const i = r * 9 + c
            const value = hidden ? 0 : (state.cells[i] ?? 0)
            return (
              <Cell
                key={i}
                index={i}
                value={value}
                notes={hidden ? [] : (state.notes[i] ?? [])}
                given={state.fixed[i] ?? false}
                selected={state.selected === i}
                tabbable={state.selected === null ? i === 0 : state.selected === i}
                peer={peers.has(i)}
                sameDigit={!hidden && selectedValue !== 0 && value === selectedValue}
                conflict={!hidden && conflicts.has(i)}
                wrong={!hidden && wrong.has(i)}
                hinted={!hidden && hinted.has(i)}
                onSelect={onSelect}
                cellRef={cellRef}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}
