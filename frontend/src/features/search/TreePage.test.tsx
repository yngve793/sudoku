import { act, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockBroadcastChannel } from '../../test/broadcast'
import { cellLabelPrefix, loginAsDemo, renderApp, seedGame } from '../../test/utils'
import { createTree, searchReducer, createSearchState } from './searchReducer'
import { syncTimers } from './sync'

const SOLVED = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'
const TRAP = '004000012002090300190000507800000020426800001700920054061050080200000635340080070'

// The tree tab's `hello` timeout never fires on its own here: tests call
// `fireHelloTimeouts()` when they want the read-only fallback. Deterministic
// under any CPU load.
let pendingTimeouts: (() => void)[] = []
const realSchedule = syncTimers.schedule
function fireHelloTimeouts() {
  const due = pendingTimeouts
  pendingTimeouts = []
  act(() => due.forEach((fn) => fn()))
}

beforeEach(() => {
  MockBroadcastChannel.reset()
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
  pendingTimeouts = []
  syncTimers.schedule = (fn) => {
    pendingTimeouts.push(fn)
    return () => {
      pendingTimeouts = pendingTimeouts.filter((f) => f !== fn)
    }
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  syncTimers.schedule = realSchedule
})

function savedTree() {
  return searchReducer(searchReducer(createSearchState(), { type: 'create', rootBoard: TRAP }), {
    type: 'guess',
    cell: 35,
    value: 3,
  }).tree
}

async function openTree(id: number) {
  const view = renderApp(`/game/${id}/tree`)
  await within(view.container).findByRole('heading', { name: 'Search tree' })
  return view
}

describe('TreePage', () => {
  it('shows "Game not found" for an unknown or foreign game', async () => {
    await loginAsDemo()
    const view = renderApp('/game/424242/tree')
    expect(await within(view.container).findByText('Game not found')).toBeInTheDocument()
  })

  it('without a game tab: shows the saved tree read-only, with a reload action', async () => {
    await loginAsDemo()
    const game = seedGame({
      givens: TRAP,
      current: TRAP,
      solution: SOLVED,
      search_tree: savedTree(),
    })
    const view = await openTree(game.id)
    const ui = within(view.container)
    expect(ui.getByText('Connecting to the game tab…')).toBeInTheDocument()
    expect(ui.getByRole('treeitem', { name: /^r4c9 equals 3, dead: / })).toBeInTheDocument()
    await waitFor(() => expect(pendingTimeouts).toHaveLength(1)) // hello sent, waiting
    fireHelloTimeouts()
    expect(ui.getByText(/No open game tab/)).toBeInTheDocument()
    expect(ui.getByRole('button', { name: /^Delete branch/ })).toBeDisabled()
    expect(ui.getByRole('button', { name: /^Branch on all/ })).toBeDisabled()
    // Local selection still works (view only, nothing is sent).
    const sent = MockBroadcastChannel.log.length
    await view.user.click(ui.getByRole('treeitem', { name: /^Start position/ }))
    expect(ui.getByRole('treeitem', { name: /^Start position/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(MockBroadcastChannel.log.length).toBe(sent)
    expect(ui.getByRole('button', { name: 'Reload saved tree' })).toBeInTheDocument()
  })

  it('a finished game is shown read-only with a notice', async () => {
    await loginAsDemo()
    const game = seedGame({ status: 'completed', score: 5, search_tree: null })
    const view = await openTree(game.id)
    expect(within(view.container).getByText('Game finished')).toBeInTheDocument()
    expect(within(view.container).getByText(/No search tree yet/)).toBeInTheDocument()
  })

  it('live with the game tab: select a step, guess and branch from the tree tab', async () => {
    await loginAsDemo()
    const game = seedGame({ givens: TRAP, current: TRAP, solution: SOLVED })
    const gameView = renderApp(`/game/${game.id}`)
    const g = within(gameView.container)
    await g.findByRole('grid', { name: 'Sudoku board' })
    await gameView.user.keyboard('s')
    await gameView.user.click(
      g.getByRole('gridcell', { name: new RegExp(`^${cellLabelPrefix(0)}`) }),
    )
    await gameView.user.keyboard('g5')
    await gameView.user.click(
      g.getByRole('gridcell', { name: new RegExp(`^${cellLabelPrefix(1)}`) }),
    )
    await gameView.user.keyboard('3')
    expect(g.getByRole('grid', { name: 'Search board, r1c1=5' })).toBeInTheDocument()

    const treeView = await openTree(game.id)
    const t = within(treeView.container)
    expect(await t.findByText(/Live: synced with the game tab/)).toBeInTheDocument()
    // The tree tab follows the game tab's selection (end of the chain).
    expect(t.getByRole('treeitem', { name: /^r1c2 equals 3, placed manually/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // Select the guess step in the tree tab: the game board shows that step.
    const before = MockBroadcastChannel.sent('select').length
    await treeView.user.click(t.getByRole('treeitem', { name: /^r1c1 equals 5/ }))
    expect(
      await g.findByRole('grid', { name: 'Search board, r1c1=5, step 1 of 2' }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(t.getByRole('treeitem', { name: /^r1c1 equals 5/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    )
    // Exactly one command; the echoed snapshot is not re-sent.
    for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve())
    expect(MockBroadcastChannel.sent('select').length).toBe(before + 1)

    // Guess from the tree tab with the picker (r4c9 = 3 contradicts).
    await treeView.user.selectOptions(t.getByLabelText('Row'), '4')
    await treeView.user.selectOptions(t.getByLabelText('Column'), '9')
    expect(t.getByText(/^Candidates for r4c9:/)).toBeInTheDocument()
    await treeView.user.selectOptions(t.getByLabelText('Value'), '3')
    await treeView.user.click(t.getByRole('button', { name: 'Guess r4c9=3' }))
    // The new node appears in both tabs.
    expect(await t.findByRole('treeitem', { name: /^r4c9 equals 3, dead: / })).toBeInTheDocument()
    expect(await g.findByRole('treeitem', { name: /^r4c9 equals 3, dead: / })).toBeInTheDocument()
    expect(await g.findByRole('grid', { name: 'Search board, r4c9=3' })).toBeInTheDocument()

    // Closing the game tab turns the tree tab read-only.
    gameView.unmount()
    expect(await t.findByText(/No open game tab/)).toBeInTheDocument()
    expect(t.getByRole('treeitem', { name: /^r4c9 equals 3, dead: / })).toBeInTheDocument()
  })

  it('commands from the tree tab turn search mode on in the game tab', async () => {
    await loginAsDemo()
    const game = seedGame({
      givens: TRAP,
      current: TRAP,
      solution: SOLVED,
      search_tree: createTree(TRAP),
    })
    const gameView = renderApp(`/game/${game.id}`)
    const g = within(gameView.container)
    await g.findByRole('grid', { name: 'Sudoku board' })
    const treeView = await openTree(game.id)
    const t = within(treeView.container)
    expect(await t.findByText(/Search mode is off there/)).toBeInTheDocument()
    await treeView.user.selectOptions(t.getByLabelText('Row'), '4')
    await treeView.user.selectOptions(t.getByLabelText('Column'), '9')
    await treeView.user.click(t.getByRole('button', { name: 'Branch on all (3)' }))
    expect(await g.findByRole('region', { name: 'Search' })).toBeInTheDocument()
    expect(
      await t.findByRole('treeitem', {
        name: 'Start position, dead: every option for r4c9 fails.',
      }),
    ).toBeInTheDocument()
  })
})
