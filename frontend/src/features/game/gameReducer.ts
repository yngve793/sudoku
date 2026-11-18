import type { NotesWire } from '../../api/types'
import {
  CELL_COUNT,
  PEERS,
  colOf,
  emptyNotes,
  findConflicts,
  isFilled,
  parseGrid,
  parseNotes,
  rowOf,
  indexOf,
  type Cells,
  type Notes,
} from './grid'

/** Max number of undo steps kept in memory. */
export const HISTORY_LIMIT = 300

export interface Snapshot {
  cells: Cells
  notes: Notes
  /** Cell that the change was made in; re-selected on undo/redo. */
  index: number
}

export interface GameState {
  /** true where the cell is a given (immutable). */
  fixed: readonly boolean[]
  cells: Cells
  notes: Notes
  selected: number | null
  notesMode: boolean
  past: readonly Snapshot[]
  future: readonly Snapshot[]
  /** Bumped on every content change (place/erase/note/undo/redo/load). */
  revision: number
  /** true when there are changes not yet acknowledged by the server. */
  dirty: boolean
  /** Cells reported wrong by the last check; cleared per cell when edited. */
  wrongCells: readonly number[]
  /** Cells highlighted by the active hint. */
  hintCells: readonly number[]
  /** No more edits allowed (completed game). */
  locked: boolean
}

export type Direction = 'up' | 'down' | 'left' | 'right'

export type GameAction =
  | { type: 'load'; givens: string; current: string; notes: NotesWire; locked?: boolean }
  | { type: 'select'; index: number | null }
  | { type: 'move'; direction: Direction }
  /** Place or toggle a note depending on notes mode. */
  | { type: 'input'; digit: number }
  | { type: 'place'; digit: number; index?: number }
  | { type: 'toggleNote'; digit: number; index?: number }
  | { type: 'erase'; index?: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'toggleNotesMode' }
  | { type: 'setNotesMode'; value: boolean }
  | { type: 'markWrong'; cells: readonly number[] }
  | { type: 'setHintCells'; cells: readonly number[] }
  | { type: 'saved'; revision: number }
  | { type: 'lock' }

export function createInitialState(): GameState {
  return {
    fixed: new Array<boolean>(CELL_COUNT).fill(false),
    cells: new Array<number>(CELL_COUNT).fill(0),
    notes: emptyNotes(),
    selected: null,
    notesMode: false,
    past: [],
    future: [],
    revision: 0,
    dirty: false,
    wrongCells: [],
    hintCells: [],
    locked: false,
  }
}

const isDigit = (d: number) => Number.isInteger(d) && d >= 1 && d <= 9
const isIndex = (i: number) => Number.isInteger(i) && i >= 0 && i < CELL_COUNT

function targetOf(state: GameState, index: number | undefined): number | null {
  const target = index ?? state.selected
  if (target === null || !isIndex(target)) return null
  return target
}

function canEdit(state: GameState, index: number | null): index is number {
  return index !== null && !state.locked && !state.fixed[index]
}

/** Records the pre-change snapshot and applies new content. */
function commit(state: GameState, index: number, cells: Cells, notes: Notes): GameState {
  const past = [...state.past, { cells: state.cells, notes: state.notes, index }]
  if (past.length > HISTORY_LIMIT) past.shift()
  return {
    ...state,
    cells,
    notes,
    past,
    future: [],
    revision: state.revision + 1,
    dirty: true,
    wrongCells: state.wrongCells.filter((i) => i !== index),
    hintCells: [],
  }
}

function withNotesAt(notes: Notes, index: number, digits: readonly number[]): Notes {
  const next = notes.slice()
  next[index] = digits
  return next
}

function place(state: GameState, digit: number, index: number | undefined): GameState {
  const target = targetOf(state, index)
  if (!isDigit(digit) || !canEdit(state, target)) return state

  // Entering the same digit again clears the cell (toggle behaviour).
  if (state.cells[target] === digit) return erase(state, target)

  const cells = state.cells.slice()
  cells[target] = digit
  // Auto-remove the digit from the notes of every peer, and clear the cell's own notes.
  const notes = state.notes.slice()
  notes[target] = []
  for (const peer of PEERS[target] ?? []) {
    const peerNotes = notes[peer] ?? []
    if (peerNotes.includes(digit)) notes[peer] = peerNotes.filter((d) => d !== digit)
  }
  return commit(state, target, cells, notes)
}

function toggleNote(state: GameState, digit: number, index: number | undefined): GameState {
  const target = targetOf(state, index)
  if (!isDigit(digit) || !canEdit(state, target)) return state
  if (state.cells[target] !== 0) return state // notes only on empty cells

  const current = state.notes[target] ?? []
  const digits = current.includes(digit)
    ? current.filter((d) => d !== digit)
    : [...current, digit].sort((a, b) => a - b)
  return commit(state, target, state.cells, withNotesAt(state.notes, target, digits))
}

function erase(state: GameState, index: number | undefined): GameState {
  const target = targetOf(state, index)
  if (!canEdit(state, target)) return state
  if (state.cells[target] !== 0) {
    const cells = state.cells.slice()
    cells[target] = 0
    return commit(state, target, cells, state.notes)
  }
  if ((state.notes[target] ?? []).length) {
    return commit(state, target, state.cells, withNotesAt(state.notes, target, []))
  }
  return state
}

function move(state: GameState, direction: Direction): GameState {
  if (state.selected === null) return { ...state, selected: 0 }
  let row = rowOf(state.selected)
  let col = colOf(state.selected)
  switch (direction) {
    case 'up':
      row = (row + 8) % 9
      break
    case 'down':
      row = (row + 1) % 9
      break
    case 'left':
      col = (col + 8) % 9
      break
    case 'right':
      col = (col + 1) % 9
      break
  }
  return { ...state, selected: indexOf(row, col) }
}

function travel(state: GameState, from: 'past' | 'future'): GameState {
  const stack = state[from]
  const snapshot = stack[stack.length - 1]
  if (!snapshot || state.locked) return state
  const inverse: Snapshot = { cells: state.cells, notes: state.notes, index: snapshot.index }
  const rest = stack.slice(0, -1)
  return {
    ...state,
    cells: snapshot.cells,
    notes: snapshot.notes,
    selected: snapshot.index,
    past: from === 'past' ? rest : [...state.past, inverse],
    future: from === 'future' ? rest : [...state.future, inverse],
    revision: state.revision + 1,
    dirty: true,
    wrongCells: [],
    hintCells: [],
  }
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'load': {
      const givens = parseGrid(action.givens)
      const current = parseGrid(action.current)
      // Givens always win, whatever the saved board says.
      const cells = current.map((v, i) => {
        const given = givens[i] ?? 0
        return given !== 0 ? given : v
      })
      return {
        ...createInitialState(),
        fixed: givens.map((v) => v !== 0),
        cells,
        notes: parseNotes(action.notes).map((d, i) => (cells[i] ? [] : d)),
        selected: state.selected,
        notesMode: state.notesMode,
        revision: state.revision + 1,
        locked: action.locked ?? false,
      }
    }
    case 'select':
      if (action.index !== null && !isIndex(action.index)) return state
      return { ...state, selected: action.index }
    case 'move':
      return move(state, action.direction)
    case 'input':
      return state.notesMode
        ? toggleNote(state, action.digit, undefined)
        : place(state, action.digit, undefined)
    case 'place':
      return place(state, action.digit, action.index)
    case 'toggleNote':
      return toggleNote(state, action.digit, action.index)
    case 'erase':
      return erase(state, action.index)
    case 'undo':
      return travel(state, 'past')
    case 'redo':
      return travel(state, 'future')
    case 'toggleNotesMode':
      return { ...state, notesMode: !state.notesMode }
    case 'setNotesMode':
      return { ...state, notesMode: action.value }
    case 'markWrong':
      return { ...state, wrongCells: action.cells.filter(isIndex) }
    case 'setHintCells':
      return { ...state, hintCells: action.cells.filter(isIndex) }
    case 'saved':
      return action.revision === state.revision ? { ...state, dirty: false } : state
    case 'lock':
      return { ...state, locked: true, notesMode: false }
  }
}

// ---------- selectors ----------

export const canUndo = (state: GameState) => !state.locked && state.past.length > 0
export const canRedo = (state: GameState) => !state.locked && state.future.length > 0

export function selectConflicts(state: GameState): Set<number> {
  return findConflicts(state.cells)
}

/** Board is full and has no visible conflicts: worth asking the server to verify. */
export function isBoardComplete(state: GameState): boolean {
  return isFilled(state.cells) && findConflicts(state.cells).size === 0
}
