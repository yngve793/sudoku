import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { db, type MockGame } from '../../mocks/db'
import { server } from '../../mocks/node'
import { cellLabelPrefix, loginAsDemo, renderApp, seedGame } from '../../test/utils'
import { parseGrid } from '../game/grid'
import { candidates, findContradiction } from './constraints'

const SOLVED = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'
/** Consistent board where every option for r4c9 (cell 35: 3, 6, 9) is a contradiction. */
const TRAP = '004000012002090300190000507800000020426800001700920054061050080200000635340080070'
/** One hole per row, column and box: each is a naked single. */
const HOLES = [0, 13, 26, 30, 43, 47, 60, 64, 77]
const NINE_HOLES = [...SOLVED].map((c, i) => (HOLES.includes(i) ? '0' : c)).join('')

function cell(index: number): HTMLElement {
  return screen.getByRole('gridcell', { name: new RegExp(`^${cellLabelPrefix(index)}`) })
}

function serverGame(id: number): MockGame {
  const game = db.games.find((g) => g.id === id)
  if (!game) throw new Error('missing game')
  return game
}

const treeItem = (name: string | RegExp) => screen.getByRole('treeitem', { name })

async function openSearch(givens = TRAP, overrides: Partial<MockGame> = {}) {
  await loginAsDemo()
  const game = seedGame({ givens, current: givens, solution: SOLVED, ...overrides })
  const view = renderApp(`/game/${game.id}`)
  await screen.findByRole('grid', { name: 'Sudoku board' })
  await view.user.keyboard('s')
  await screen.findByRole('grid', { name: 'Search board, Start' })
  return { ...view, game }
}

describe('search mode', () => {
  it('toggles with S and the button; the main board is read-only meanwhile', async () => {
    const { user, game } = await openSearch()
    expect(screen.getByRole('region', { name: 'Search' })).toBeInTheDocument()
    expect(screen.queryByRole('toolbar', { name: 'Game controls' })).toBeNull()
    // A digit at the root starts a guess instead of editing the main board.
    await user.click(cell(0))
    await user.keyboard('5')
    expect(screen.getByRole('grid', { name: 'Search board, r1c1=5' })).toBeInTheDocument()
    expect(cell(0)).toHaveAccessibleName(`${cellLabelPrefix(0)} 5, guess`)

    await user.click(screen.getByRole('button', { name: 'Exit search' }))
    expect(screen.getByRole('grid', { name: 'Sudoku board' })).toBeInTheDocument()
    expect(cell(0)).toHaveAccessibleName(`${cellLabelPrefix(0)} empty`)
    expect(serverGame(game.id).current).toBe(TRAP)

    // The tree is kept; the Search button resumes it.
    await user.click(screen.getByRole('button', { name: 'Search…' }))
    expect(screen.getByRole('grid', { name: 'Search board, r1c1=5' })).toBeInTheDocument()
  })

  it('guesses with G + digit and shows the node in the graph', async () => {
    const { user } = await openSearch()
    await user.click(cell(1))
    await user.keyboard('g')
    expect(screen.getByText(/Guess for r1c2: press a digit/)).toBeInTheDocument()
    await user.keyboard('3')
    const node = treeItem(/^r1c2 equals 3/)
    expect(node).toHaveAttribute('aria-selected', 'true')
    expect(within(node).getByText('r1c2=3', { selector: 'text' })).toBeInTheDocument()
    expect(treeItem(/^Start position/)).toHaveAttribute('aria-expanded', 'true')

    // The Guess button + number pad does the same; a second distinct choice is a sibling.
    await user.click(treeItem(/^Start position/))
    await user.click(cell(1))
    await user.click(screen.getByRole('button', { name: 'Guess…' }))
    await user.click(screen.getByRole('button', { name: /^Guess 5,/ }))
    expect(treeItem(/^r1c2 equals 5/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
  })

  it('marks a contradiction with ✗ on the board and in the graph; dead nodes cannot be applied', async () => {
    const { user } = await openSearch()
    await user.click(cell(35))
    await user.keyboard('g3')
    const node = treeItem(/^r4c9 equals 3, dead: /)
    const board = parseGrid(TRAP)
    board[35] = 3
    const contradiction = findContradiction(board)!
    expect(node).toHaveAccessibleName(
      `r4c9 equals 3, dead: ${contradiction.explanation.replace(/\.$/, '')}.`,
    )
    expect(node.querySelector('.graph-node__cross')).not.toBeNull()
    for (const c of contradiction.cells) expect(cell(c)).toHaveAccessibleName(/, contradiction$/)
    expect(screen.getByText(/^Dead: /)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply branch' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Guess…' })).toBeDisabled()
  })

  it('branches on all candidates with B and propagates death upwards', async () => {
    const { user } = await openSearch()
    await user.click(cell(35))
    await user.keyboard('b')
    for (const v of [3, 6, 9])
      expect(treeItem(new RegExp(`^r4c9 equals ${v}, dead: `))).toBeInTheDocument()
    expect(treeItem('Start position, dead: every option for r4c9 fails.')).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText('Dead: every option for r4c9 fails.')).toBeInTheDocument()
  })

  it('applies a live branch as one undoable step', async () => {
    const { user, game } = await openSearch()
    const board = parseGrid(TRAP)
    const live = candidates(board, 0).find((v) => {
      const next = board.slice()
      next[0] = v
      return findContradiction(next) === null
    })!
    await user.click(cell(0))
    await user.keyboard(`g${live}`)
    const after = board.slice()
    after[0] = live
    const placement = candidates(after, 1)[0]!
    await user.click(cell(1))
    await user.keyboard(String(placement))
    expect(cell(1)).toHaveAccessibleName(`${cellLabelPrefix(1)} ${placement}, placed`)

    await user.click(screen.getByRole('button', { name: 'Apply branch' }))
    expect(screen.getByRole('grid', { name: 'Sudoku board' })).toBeInTheDocument()
    expect(screen.getAllByText(/Applied 2 cells from r1c1=\d to the board/).length).toBeGreaterThan(
      0,
    )
    expect(cell(0)).toHaveAccessibleName(`${cellLabelPrefix(0)} ${live}`)
    expect(cell(1)).toHaveAccessibleName(`${cellLabelPrefix(1)} ${placement}`)

    await user.keyboard('{Control>}z{/Control}')
    expect(cell(0)).toHaveAccessibleName(`${cellLabelPrefix(0)} empty`)
    expect(cell(1)).toHaveAccessibleName(`${cellLabelPrefix(1)} empty`)
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}')
    expect(cell(0)).toHaveAccessibleName(`${cellLabelPrefix(0)} ${live}`)
    expect(serverGame(game.id).search_tree ?? null).toBeNull() // not saved yet (debounce)
  })

  it('auto mode shows its cost first, calls propagate and shows the running cost', async () => {
    const bodies: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/search/propagate'))
        void request
          .clone()
          .json()
          .then((b: { board: string }) => bodies.push(b.board))
    })
    const { user, game } = await openSearch(NINE_HOLES)
    await user.click(screen.getByRole('radio', { name: 'Auto (−2/cell)' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Enable auto mode' })
    expect(confirm).toHaveTextContent('Auto fills direct implications: −2 points per filled cell.')
    expect(screen.getByRole('radio', { name: 'Manual' })).toBeChecked()
    await user.click(within(confirm).getByRole('button', { name: 'Enable auto' }))
    expect(screen.getByRole('radio', { name: 'Auto (−2/cell)' })).toBeChecked()

    await user.click(cell(0))
    await user.keyboard('g5')
    expect(await screen.findByText(/^Auto placements:/)).toHaveTextContent(
      'Auto placements: 8 (−16 points)',
    )
    expect(bodies[0]).toBe(`5${NINE_HOLES.slice(1)}`)
    expect(cell(13)).toHaveAccessibleName(`${cellLabelPrefix(13)} ${SOLVED[13]}, implied`)
    expect(treeItem('r1c1 equals 5, 8 implications, solved.')).toBeInTheDocument()
    expect(serverGame(game.id).auto_placements).toBe(8)
    expect(screen.getByText('Auto').nextSibling).toHaveTextContent('8')
    server.events.removeAllListeners()
  })

  it('applying a solved branch completes the game; the breakdown shows the search penalty', async () => {
    const { user, game } = await openSearch(NINE_HOLES)
    await user.click(screen.getByRole('radio', { name: 'Auto (−2/cell)' }))
    await user.click(screen.getByRole('button', { name: 'Enable auto' }))
    await user.click(cell(0))
    await user.keyboard('g5')
    await screen.findByRole('treeitem', { name: 'r1c1 equals 5, 8 implications, solved.' })
    await user.click(screen.getByRole('button', { name: 'Apply branch' }))
    const dialog = await screen.findByRole('dialog', { name: 'Puzzle solved!' }, { timeout: 3000 })
    const breakdown = within(dialog).getByRole('table', { name: 'Score breakdown' })
    expect(within(breakdown).getByRole('row', { name: /Search/ })).toHaveTextContent('−16')
    expect(serverGame(game.id).status).toBe('completed')
    expect(within(breakdown).getByRole('row', { name: /Total/ })).toHaveTextContent(
      String(serverGame(game.id).score),
    )
  })

  it('every implication is its own node; selecting one shows the board up to that step', async () => {
    const { user } = await openSearch(NINE_HOLES)
    await user.click(screen.getByRole('radio', { name: 'Auto (−2/cell)' }))
    await user.click(screen.getByRole('button', { name: 'Enable auto' }))
    await user.click(cell(0))
    await user.keyboard('g5')
    expect(await screen.findByText(/^Auto placements:/)).toHaveTextContent(
      'Auto placements: 8 (−16 points)',
    )
    // Compact view: the long chain card shows "… n more" until opened.
    await user.click(screen.getByRole('button', { name: /^Show \d+ more steps$/ }))
    const steps = screen.getAllByRole('treeitem', {
      name: /, implied by Naked Single, step \d of 8 after r1c1 equals 5/,
    })
    expect(steps).toHaveLength(8)
    expect(steps[0]).toHaveAttribute('data-kind', 'auto')
    // The end of the chain is selected and solved.
    expect(steps[7]).toHaveAttribute('aria-selected', 'true')
    expect(steps[7]).toHaveAccessibleName(/step 8 of 8 after r1c1 equals 5, board solved\.$/)

    // Select step 2: the board shows the guess + the first two implications.
    const second = steps[1]!
    await user.click(second)
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('grid', { name: 'Search board, r1c1=5, step 3 of 9' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('gridcell', { name: /, implied/ })).toHaveLength(2)
    expect(screen.getByRole('gridcell', { name: /, implied, viewed step$/ })).toBeInTheDocument()
    expect(screen.getByText(/Viewing step 2 of 8\./)).toBeInTheDocument()

    // Board actions apply to the full state and jump to the end of the chain.
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Exit search' }))
    await user.keyboard('s')
    expect(
      screen.getByRole('grid', { name: 'Search board, r1c1=5, step 3 of 9' }),
    ).toBeInTheDocument()
    await user.click(cell(13))
    await user.keyboard('{Backspace}') // erase: an auto cell, a no-op on the tree
    expect(screen.getByRole('grid', { name: 'Search board, r1c1=5' })).toBeInTheDocument()
    expect(screen.getAllByRole('gridcell', { name: /, implied/ })).toHaveLength(8)
  })

  it('shows propagate errors without breaking the tree', async () => {
    server.use(
      http.post('*/api/v1/games/:id/search/propagate', () =>
        HttpResponse.json({ detail: 'Slow down', code: 'rate_limited' }, { status: 429 }),
      ),
    )
    const { user } = await openSearch(NINE_HOLES, { search_tree: null })
    await user.click(screen.getByRole('radio', { name: 'Auto (−2/cell)' }))
    await user.click(screen.getByRole('button', { name: 'Enable auto' }))
    await user.click(cell(0))
    await user.keyboard('g5')
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/)
    expect(treeItem(/^r1c1 equals 5\.$/)).toBeInTheDocument()
  })

  it('saves the tree with autosave and restores it after a remount', async () => {
    const { user, game, unmount } = await openSearch()
    await user.click(cell(35))
    await user.keyboard('b')
    await waitFor(() => expect(serverGame(game.id).search_tree?.nodes).toHaveLength(4), {
      timeout: 3000,
    })
    expect(serverGame(game.id).search_tree?.nodes[0]?.branch_cell).toBe(35)
    unmount()

    const again = renderApp(`/game/${game.id}`)
    await screen.findByRole('grid', { name: 'Sudoku board' })
    await again.user.keyboard('s')
    expect(screen.getAllByRole('treeitem')).toHaveLength(4)
    expect(treeItem('Start position, dead: every option for r4c9 fails.')).toBeInTheDocument()
  })

  it('keeps saving the board when the server rejects the tree (422), without looping', async () => {
    let rejected = 0
    server.use(
      http.patch('*/api/v1/games/:id', async ({ request }) => {
        const body = (await request.clone().json()) as Record<string, unknown>
        if ('search_tree' in body) {
          rejected += 1
          return HttpResponse.json(
            { detail: 'body.search_tree: too large', code: 'validation_error' },
            { status: 422 },
          )
        }
        return undefined
      }),
    )
    const { user, game } = await openSearch()
    await user.click(cell(1))
    await user.keyboard('g3')
    expect(
      await screen.findByText(/search tree couldn't be saved/, {}, { timeout: 3000 }),
    ).toBeInTheDocument()
    await waitFor(() => expect(serverGame(game.id).version).toBe(2))
    expect(serverGame(game.id).search_tree ?? null).toBeNull()
    // Change the tree again, then make a board edit so a save must happen:
    // it goes through without the (blocked) tree, so no second rejection.
    await user.click(cell(2 + 2)) // r1c5
    await user.keyboard('g7')
    await user.click(screen.getByRole('button', { name: 'Exit search' }))
    await user.click(cell(1))
    await user.keyboard('n4')
    await waitFor(() => expect(serverGame(game.id).version).toBe(3), { timeout: 5000 })
    expect(rejected).toBe(1)
    expect(serverGame(game.id).notes).toEqual({ '1': [4] })
  })

  it('erases, deletes branches, resets the tree, and cancels auto or a pending guess', async () => {
    const { user } = await openSearch()
    await user.click(cell(1))
    await user.keyboard('g3')
    await user.click(cell(4))
    await user.keyboard('6')
    expect(cell(4)).toHaveAccessibleName(`${cellLabelPrefix(4)} 6, placed`)
    await user.click(screen.getByRole('button', { name: 'Erase' }))
    expect(cell(4)).toHaveAccessibleName(`${cellLabelPrefix(4)} empty`)
    await user.keyboard('6{Backspace}')
    expect(cell(4)).toHaveAccessibleName(`${cellLabelPrefix(4)} empty`)

    // Escape cancels a pending guess.
    await user.keyboard('g')
    expect(screen.getByRole('button', { name: 'Guess…' })).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Guess…' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Delete branch' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Delete branch' })).toBeDisabled()

    await user.keyboard('5') // root: a digit starts a guess at r1c5
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Reset tree' }))
    await user.click(screen.getByRole('button', { name: 'Keep tree' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Reset tree' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
    expect(screen.getByText('New tree started from the current board.')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Auto (−2/cell)' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('radio', { name: 'Manual' })).toBeChecked()
    expect(screen.queryByRole('alertdialog')).toBeNull()

    // The graph can be hidden (mobile) and shown again.
    await user.click(screen.getByRole('button', { name: 'Hide tree' }))
    expect(screen.queryByRole('tree')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show tree' }))
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })

  it('asks for an empty cell before guessing or branching', async () => {
    const { user } = await openSearch()
    await user.click(cell(2)) // a given
    await user.keyboard('b')
    expect(screen.getByText('Select an empty cell to branch on.')).toBeInTheDocument()
    await user.keyboard('g4')
    expect(screen.getByText('Select an empty cell to guess.')).toBeInTheDocument()
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
  })

  it('S does nothing for a finished game', async () => {
    await loginAsDemo()
    const game = seedGame({ status: 'completed', score: 10 })
    const { user } = renderApp(`/game/${game.id}`)
    await screen.findByRole('grid', { name: 'Sudoku board' })
    await user.keyboard('s')
    expect(screen.queryByRole('region', { name: 'Search' })).toBeNull()
  })
})
