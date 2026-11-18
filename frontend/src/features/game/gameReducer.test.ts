import { describe, expect, it } from 'vitest'
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  createInitialState,
  gameReducer,
  isBoardComplete,
  selectConflicts,
  type GameAction,
  type GameState,
} from './gameReducer'

// Classic puzzle and its solution (only used to build fixtures, never by app code).
const GIVENS = '530070000600195000098000060800060003400803001700020006060000280000419005000080079'
const SOLUTION = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'

function load(current = GIVENS, notes: Record<string, number[]> = {}): GameState {
  return gameReducer(createInitialState(), { type: 'load', givens: GIVENS, current, notes })
}

function run(state: GameState, ...actions: GameAction[]): GameState {
  return actions.reduce(gameReducer, state)
}

// r1c3 (index 2) is empty; its solution value is 4.
const EMPTY = 2
const GIVEN = 0 // r1c1 = 5

describe('load', () => {
  it('parses givens, current and notes', () => {
    const current = GIVENS.slice(0, 2) + '4' + GIVENS.slice(3)
    const s = load(current, { '3': [2, 6, 1], '2': [9] })
    expect(s.fixed[GIVEN]).toBe(true)
    expect(s.fixed[EMPTY]).toBe(false)
    expect(s.cells[EMPTY]).toBe(4)
    expect(s.notes[3]).toEqual([1, 2, 6])
    // notes on filled cells are dropped
    expect(s.notes[EMPTY]).toEqual([])
    expect(s.dirty).toBe(false)
    expect(s.past).toEqual([])
  })

  it('keeps givens even if current disagrees', () => {
    const current = '9' + GIVENS.slice(1)
    expect(load(current).cells[GIVEN]).toBe(5)
  })

  it('ignores out-of-range note keys and digits', () => {
    const s = load(GIVENS, { '-1': [1], '81': [2], x: [3], '5': [0, 10, 5, 5] })
    expect(s.notes[5]).toEqual([5])
  })

  it('rejects malformed grids', () => {
    expect(() =>
      gameReducer(createInitialState(), {
        type: 'load',
        givens: 'abc',
        current: GIVENS,
        notes: {},
      }),
    ).toThrow()
  })

  it('bumps revision, clears history and keeps selection and notes mode', () => {
    let s = run(load(), { type: 'select', index: EMPTY }, { type: 'toggleNotesMode' })
    s = run(s, { type: 'input', digit: 1 })
    const reloaded = gameReducer(s, { type: 'load', givens: GIVENS, current: GIVENS, notes: {} })
    expect(reloaded.revision).toBe(s.revision + 1)
    expect(reloaded.past).toEqual([])
    expect(reloaded.selected).toBe(EMPTY)
    expect(reloaded.notesMode).toBe(true)
  })

  it('can load a locked (completed) board', () => {
    const s = gameReducer(createInitialState(), {
      type: 'load',
      givens: GIVENS,
      current: SOLUTION,
      notes: {},
      locked: true,
    })
    expect(s.locked).toBe(true)
  })
})

describe('select and move', () => {
  it('selects a valid index and clears with null', () => {
    let s = gameReducer(load(), { type: 'select', index: 40 })
    expect(s.selected).toBe(40)
    s = gameReducer(s, { type: 'select', index: null })
    expect(s.selected).toBeNull()
  })

  it('ignores invalid indices', () => {
    const s = load()
    expect(gameReducer(s, { type: 'select', index: 81 })).toBe(s)
    expect(gameReducer(s, { type: 'select', index: 1.5 })).toBe(s)
  })

  it('selects the first cell when moving with no selection', () => {
    expect(gameReducer(load(), { type: 'move', direction: 'down' }).selected).toBe(0)
  })

  it.each([
    ['up', 40, 31],
    ['down', 40, 49],
    ['left', 40, 39],
    ['right', 40, 41],
    ['up', 4, 76],
    ['down', 76, 4],
    ['left', 36, 44],
    ['right', 44, 36],
  ] as const)('moves %s from %i to %i (wrapping)', (direction, from, to) => {
    const s = run(load(), { type: 'select', index: from }, { type: 'move', direction })
    expect(s.selected).toBe(to)
  })
})

describe('place', () => {
  it('places a digit in the selected empty cell', () => {
    const s = run(load(), { type: 'select', index: EMPTY }, { type: 'place', digit: 4 })
    expect(s.cells[EMPTY]).toBe(4)
    expect(s.dirty).toBe(true)
    expect(s.past).toHaveLength(1)
  })

  it('accepts an explicit index', () => {
    expect(gameReducer(load(), { type: 'place', digit: 4, index: EMPTY }).cells[EMPTY]).toBe(4)
  })

  it('does nothing without a selection', () => {
    const s = load()
    expect(gameReducer(s, { type: 'place', digit: 4 })).toBe(s)
  })

  it('never changes a given', () => {
    const s = load()
    expect(gameReducer(s, { type: 'place', digit: 1, index: GIVEN })).toBe(s)
  })

  it.each([0, 10, -1, 2.5])('rejects digit %s', (digit) => {
    const s = load()
    expect(gameReducer(s, { type: 'place', digit, index: EMPTY })).toBe(s)
  })

  it('replaces an existing user value', () => {
    const s = run(
      load(),
      { type: 'place', digit: 4, index: EMPTY },
      { type: 'place', digit: 7, index: EMPTY },
    )
    expect(s.cells[EMPTY]).toBe(7)
    expect(s.past).toHaveLength(2)
  })

  it('placing the same digit again clears the cell', () => {
    const s = run(
      load(),
      { type: 'place', digit: 4, index: EMPTY },
      { type: 'place', digit: 4, index: EMPTY },
    )
    expect(s.cells[EMPTY]).toBe(0)
  })

  it('clears own notes and auto-removes the digit from peer notes only', () => {
    // index 3 (r1c4) is a peer of 2 (same row); 20 (r3c3) shares the box; 77 is unrelated.
    const s0 = load(GIVENS, { '2': [1, 4], '3': [2, 4], '20': [4], '77': [4] })
    const s = gameReducer(s0, { type: 'place', digit: 4, index: EMPTY })
    expect(s.notes[EMPTY]).toEqual([])
    expect(s.notes[3]).toEqual([2])
    expect(s.notes[20]).toEqual([])
    expect(s.notes[77]).toEqual([4])
  })

  it('clears the wrong mark and hint highlight on edit', () => {
    let s = run(
      load(),
      { type: 'markWrong', cells: [EMPTY, 3] },
      { type: 'setHintCells', cells: [5] },
    )
    s = gameReducer(s, { type: 'place', digit: 4, index: EMPTY })
    expect(s.wrongCells).toEqual([3])
    expect(s.hintCells).toEqual([])
  })
})

describe('notes', () => {
  it('toggles notes on and off, keeping them sorted', () => {
    let s = run(
      load(),
      { type: 'toggleNote', digit: 7, index: EMPTY },
      { type: 'toggleNote', digit: 2, index: EMPTY },
    )
    expect(s.notes[EMPTY]).toEqual([2, 7])
    s = gameReducer(s, { type: 'toggleNote', digit: 7, index: EMPTY })
    expect(s.notes[EMPTY]).toEqual([2])
  })

  it('does not add notes to filled cells or givens', () => {
    const filled = gameReducer(load(), { type: 'place', digit: 4, index: EMPTY })
    expect(gameReducer(filled, { type: 'toggleNote', digit: 1, index: EMPTY })).toBe(filled)
    const s = load()
    expect(gameReducer(s, { type: 'toggleNote', digit: 1, index: GIVEN })).toBe(s)
  })

  it('rejects invalid digits', () => {
    const s = load()
    expect(gameReducer(s, { type: 'toggleNote', digit: 0, index: EMPTY })).toBe(s)
  })

  it('input respects notes mode', () => {
    let s = run(load(), { type: 'select', index: EMPTY }, { type: 'input', digit: 3 })
    expect(s.cells[EMPTY]).toBe(3)
    s = run(
      load(),
      { type: 'select', index: EMPTY },
      { type: 'toggleNotesMode' },
      { type: 'input', digit: 3 },
    )
    expect(s.cells[EMPTY]).toBe(0)
    expect(s.notes[EMPTY]).toEqual([3])
  })

  it('setNotesMode sets an explicit value', () => {
    expect(gameReducer(load(), { type: 'setNotesMode', value: true }).notesMode).toBe(true)
    expect(gameReducer(load(), { type: 'setNotesMode', value: false }).notesMode).toBe(false)
  })
})

describe('erase', () => {
  it('erases a value first, then notes', () => {
    let s = run(load(GIVENS, { '2': [1, 2] }), { type: 'select', index: EMPTY })
    s = gameReducer(s, { type: 'erase' })
    expect(s.notes[EMPTY]).toEqual([])
    expect(s.past).toHaveLength(1)
  })

  it('erases a placed value', () => {
    const s = run(
      load(),
      { type: 'place', digit: 4, index: EMPTY },
      { type: 'erase', index: EMPTY },
    )
    expect(s.cells[EMPTY]).toBe(0)
  })

  it('is a no-op on empty cells and givens', () => {
    const s = load()
    expect(gameReducer(s, { type: 'erase', index: EMPTY })).toBe(s)
    expect(gameReducer(s, { type: 'erase', index: GIVEN })).toBe(s)
    expect(gameReducer(s, { type: 'erase' })).toBe(s)
  })
})

describe('undo / redo', () => {
  it('undoes and redoes placements, restoring auto-removed notes', () => {
    const s0 = load(GIVENS, { '3': [4, 2] })
    const placed = gameReducer(s0, { type: 'place', digit: 4, index: EMPTY })
    const undone = gameReducer(placed, { type: 'undo' })
    expect(undone.cells[EMPTY]).toBe(0)
    expect(undone.notes[3]).toEqual([2, 4])
    expect(undone.selected).toBe(EMPTY)
    expect(canRedo(undone)).toBe(true)
    const redone = gameReducer(undone, { type: 'redo' })
    expect(redone.cells[EMPTY]).toBe(4)
    expect(redone.notes[3]).toEqual([2])
    expect(canRedo(redone)).toBe(false)
    expect(canUndo(redone)).toBe(true)
  })

  it('a new edit clears the redo stack', () => {
    let s = run(load(), { type: 'place', digit: 4, index: EMPTY }, { type: 'undo' })
    expect(s.future).toHaveLength(1)
    s = gameReducer(s, { type: 'place', digit: 1, index: 3 })
    expect(s.future).toHaveLength(0)
  })

  it('is a no-op with empty stacks', () => {
    const s = load()
    expect(gameReducer(s, { type: 'undo' })).toBe(s)
    expect(gameReducer(s, { type: 'redo' })).toBe(s)
    expect(canUndo(s)).toBe(false)
  })

  it('marks state dirty and bumps the revision', () => {
    const placed = gameReducer(load(), { type: 'place', digit: 4, index: EMPTY })
    const saved = gameReducer(placed, { type: 'saved', revision: placed.revision })
    const undone = gameReducer(saved, { type: 'undo' })
    expect(undone.dirty).toBe(true)
    expect(undone.revision).toBe(saved.revision + 1)
  })

  it('caps history length', () => {
    let s = load()
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      s = gameReducer(s, { type: 'toggleNote', digit: (i % 9) + 1, index: EMPTY })
    }
    expect(s.past).toHaveLength(HISTORY_LIMIT)
  })

  it('undoes notes', () => {
    const s = run(load(), { type: 'toggleNote', digit: 5, index: EMPTY }, { type: 'undo' })
    expect(s.notes[EMPTY]).toEqual([])
  })
})

describe('saved / dirty tracking', () => {
  it('only clears dirty when the saved revision is the latest', () => {
    const a = gameReducer(load(), { type: 'place', digit: 4, index: EMPTY })
    const b = gameReducer(a, { type: 'toggleNote', digit: 1, index: 3 })
    expect(gameReducer(b, { type: 'saved', revision: a.revision })).toBe(b)
    expect(gameReducer(b, { type: 'saved', revision: b.revision }).dirty).toBe(false)
  })
})

describe('markWrong / setHintCells', () => {
  it('filters out invalid indices', () => {
    const s = run(
      load(),
      { type: 'markWrong', cells: [1, 99] },
      { type: 'setHintCells', cells: [-1, 5] },
    )
    expect(s.wrongCells).toEqual([1])
    expect(s.hintCells).toEqual([5])
  })
})

describe('lock', () => {
  it('prevents further edits, undo and redo', () => {
    const s = run(load(), { type: 'place', digit: 4, index: EMPTY }, { type: 'lock' })
    expect(s.locked).toBe(true)
    expect(gameReducer(s, { type: 'place', digit: 1, index: 3 })).toBe(s)
    expect(gameReducer(s, { type: 'undo' })).toBe(s)
    expect(canUndo(s)).toBe(false)
    expect(canRedo(s)).toBe(false)
  })
})

describe('selectors', () => {
  it('reports conflicts between user entries and givens', () => {
    // 5 at r1c3 conflicts with the given 5 at r1c1.
    const s = gameReducer(load(), { type: 'place', digit: 5, index: EMPTY })
    expect([...selectConflicts(s)].sort((a, b) => a - b)).toEqual([0, EMPTY])
  })

  it('detects a complete, conflict-free board', () => {
    expect(isBoardComplete(load())).toBe(false)
    expect(isBoardComplete(load(SOLUTION))).toBe(true)
    // r1c3 and r1c4 are not givens; duplicating 4 there creates a row conflict.
    const broken = SOLUTION.slice(0, 3) + '4' + SOLUTION.slice(4)
    expect(isBoardComplete(load(broken))).toBe(false)
  })
})
