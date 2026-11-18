import { act, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, type MockGame } from '../../mocks/db'
import { server } from '../../mocks/node'
import {
  cellLabelPrefix,
  firstEmptyIndex,
  loginAsDemo,
  renderApp,
  seedGame,
} from '../../test/utils'

function cell(index: number): HTMLElement {
  return screen.getByRole('gridcell', { name: new RegExp(`^${cellLabelPrefix(index)}`) })
}

function serverGame(id: number): MockGame {
  const game = db.games.find((g) => g.id === id)
  if (!game) throw new Error('missing game')
  return game
}

/** A digit that is wrong for `index` but does not clash with anything visible. */
function wrongButLegal(game: MockGame, index: number): number {
  const row = Math.floor(index / 9)
  const col = index % 9
  const used = new Set<string>()
  for (let i = 0; i < 81; i++) {
    const r = Math.floor(i / 9)
    const c = i % 9
    const sameBox =
      Math.floor(r / 3) === Math.floor(row / 3) && Math.floor(c / 3) === Math.floor(col / 3)
    if (r === row || c === col || sameBox) used.add(game.current[i]!)
  }
  for (let d = 1; d <= 9; d++) {
    if (!used.has(String(d)) && String(d) !== game.solution[index]) return d
  }
  throw new Error('no wrong-but-legal digit')
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function openGame(overrides: Partial<MockGame> = {}) {
  await loginAsDemo()
  const game = seedGame(overrides)
  const view = renderApp(`/game/${game.id}`)
  await screen.findByRole('grid', { name: 'Sudoku board' })
  return { ...view, game }
}

describe('GamePage', () => {
  beforeEach(() => setVisibility('visible'))
  afterEach(() => setVisibility('visible'))

  it('renders an accessible 9x9 grid with givens marked', async () => {
    const { game } = await openGame()
    const grid = screen.getByRole('grid', { name: 'Sudoku board' })
    expect(within(grid).getAllByRole('row')).toHaveLength(9)
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(81)
    const givenIndex = [...game.givens].findIndex((c) => c !== '0')
    expect(cell(givenIndex)).toHaveAccessibleName(
      `${cellLabelPrefix(givenIndex)} ${game.givens[givenIndex]}, given`,
    )
    const empty = firstEmptyIndex(game)
    expect(cell(empty)).toHaveAccessibleName(`${cellLabelPrefix(empty)} empty`)
    expect(screen.getByText('0:30')).toBeInTheDocument()
  })

  it('supports full keyboard play: select, enter, move, notes, erase, undo', async () => {
    const { user, game } = await openGame()
    const a = firstEmptyIndex(game)
    await user.click(cell(a))
    expect(cell(a)).toHaveFocus()
    expect(cell(a)).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('5')
    expect(cell(a)).toHaveAccessibleName(new RegExp(`^${cellLabelPrefix(a)} 5`))

    await user.keyboard('{Backspace}')
    expect(cell(a)).toHaveAccessibleName(`${cellLabelPrefix(a)} empty`)

    await user.keyboard('n')
    expect(screen.getByRole('button', { name: /Notes on/ })).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('3')
    await user.keyboard('1')
    expect(cell(a)).toHaveAccessibleName(`${cellLabelPrefix(a)} empty, notes 1 3`)

    await user.keyboard('{Control>}z{/Control}')
    expect(cell(a)).toHaveAccessibleName(`${cellLabelPrefix(a)} empty, notes 3`)
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}')
    expect(cell(a)).toHaveAccessibleName(`${cellLabelPrefix(a)} empty, notes 1 3`)

    const below = a + 9 < 81 ? a + 9 : a - 72
    await user.keyboard('{ArrowDown}')
    expect(cell(below)).toHaveFocus()
    expect(cell(below)).toHaveAttribute('tabindex', '0')
    expect(cell(a)).toHaveAttribute('tabindex', '-1')
  })

  it('enters digits from the number pad and never edits givens', async () => {
    const { user, game } = await openGame()
    const givenIndex = [...game.givens].findIndex((c) => c !== '0')
    await user.click(cell(givenIndex))
    await user.click(screen.getByRole('button', { name: /^Enter 1,/ }))
    expect(cell(givenIndex)).toHaveAccessibleName(
      `${cellLabelPrefix(givenIndex)} ${game.givens[givenIndex]}, given`,
    )
    const a = firstEmptyIndex(game)
    await user.click(cell(a))
    await user.click(screen.getByRole('button', { name: /^Enter 1,/ }))
    expect(cell(a)).toHaveAccessibleName(new RegExp(`^${cellLabelPrefix(a)} 1`))
  })

  it('flags conflicts with text, not only colour', async () => {
    const { user, game } = await openGame()
    const a = firstEmptyIndex(game)
    const row = Math.floor(a / 9)
    const rowGiven = Array.from({ length: 9 }, (_, c) => row * 9 + c).find(
      (i) => game.givens[i] !== '0',
    )!
    await user.click(cell(a))
    await user.keyboard(game.givens[rowGiven]!)
    expect(cell(a)).toHaveAccessibleName(/conflict/)
    expect(cell(rowGiven)).toHaveAccessibleName(/conflict/)
  })

  it('autosaves with the version after a debounce and shows "Saved"', async () => {
    let body: Record<string, unknown> | null = null
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH')
        void request
          .clone()
          .json()
          .then((b) => (body = b as never))
    })
    const { user, game } = await openGame()
    const a = firstEmptyIndex(game)
    await user.click(cell(a))
    await user.keyboard('n4n7')
    await waitFor(() => expect(serverGame(game.id).version).toBe(2), { timeout: 3000 })
    expect(serverGame(game.id).current[a]).toBe('7')
    expect(body).toMatchObject({ version: 1, notes: {} })
    expect(screen.getByText('Saved')).toBeInTheDocument()
    server.events.removeAllListeners()
  })

  it('flushes immediately when the tab is hidden', async () => {
    const { user, game } = await openGame()
    const a = firstEmptyIndex(game)
    await user.click(cell(a))
    await user.keyboard('n2')
    act(() => setVisibility('hidden'))
    await waitFor(() => expect(serverGame(game.id).notes).toEqual({ [String(a)]: [2] }), {
      timeout: 500,
    })
  })

  it('reloads the server board and tells the user on a 409 conflict', async () => {
    const { user, game } = await openGame()
    const a = firstEmptyIndex(game)
    const b = firstEmptyIndex(game, a)
    // Another device saved meanwhile.
    const other = serverGame(game.id)
    other.version = 5
    other.current = other.current.slice(0, b) + other.solution[b]! + other.current.slice(b + 1)

    await user.click(cell(a))
    await user.keyboard('n9')
    expect(
      await screen.findByText(/changed in another tab or device/, {}, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(cell(b)).toHaveAccessibleName(new RegExp(`^${cellLabelPrefix(b)} ${other.solution[b]}`))
    expect(cell(a)).toHaveAccessibleName(`${cellLabelPrefix(a)} empty`)
  })

  it('reveals hints in three stages, showing the cost before each reveal', async () => {
    const { user, game } = await openGame()
    await user.keyboard('h')
    const panel = screen.getByRole('region', { name: 'Hint' })
    const stage1 = within(panel).getByRole('button', {
      name: 'Show technique and region (−10 points)',
    })
    expect(serverGame(game.id).hints_used).toBe(0) // opening the panel is free

    await user.click(stage1)
    expect(
      await within(panel).findByText(/^Try an? .+ in (box|row|column) \d\.$/),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('gridcell', { name: /, hint$/ }).length).toBe(9)
    expect(serverGame(game.id).hints_used).toBe(1)

    await user.keyboard('h') // H advances to the next stage
    expect(await within(panel).findByText(/Single: .*\?/)).toBeInTheDocument() // value redacted
    expect(screen.getAllByRole('gridcell', { name: /, hint$/ })).toHaveLength(1)

    await user.click(within(panel).getByRole('button', { name: 'Reveal the value (−40 points)' }))
    const fill = await within(panel).findByRole('button', { name: /^Fill in \d at r\dc\d$/ })
    expect(screen.getByText('Hints').nextSibling).toHaveTextContent('3')

    const target = screen.getAllByRole('gridcell', { name: /, hint$/ })[0]!
    const index = Number(target.dataset.index)
    await user.click(fill)
    expect(cell(index)).toHaveAccessibleName(
      new RegExp(`^${cellLabelPrefix(index)} ${game.solution[index]}`),
    )
    // The board changed, so the old hint is gone and stage 1 is offered again.
    expect(
      within(panel).getByRole('button', { name: 'Show technique and region (−10 points)' }),
    ).toBeInTheDocument()
  })

  it('gives an error hint: stage 1 says only "mistake", stage 2 names the cells', async () => {
    const { user, game } = await openGame()
    const a = firstEmptyIndex(game)
    await user.click(cell(a))
    await user.keyboard(String(wrongButLegal(game, a)))
    await user.keyboard('h')
    const panel = screen.getByRole('region', { name: 'Hint' })
    await user.click(within(panel).getByRole('button', { name: /Show technique and region/ }))
    expect(await within(panel).findByText('Your board contains a mistake.')).toBeInTheDocument()
    expect(within(panel).getByText('Mistake found')).toBeInTheDocument()
    expect(screen.queryAllByRole('gridcell', { name: /, hint$/ })).toHaveLength(0)
    await user.click(within(panel).getByRole('button', { name: /Highlight the cells/ }))
    expect(await within(panel).findByText(/is incorrect/)).toBeInTheDocument()
    expect(cell(a)).toHaveAccessibleName(/hint$/)
  })

  it('check marks incorrect cells with a ✕ and in the label', async () => {
    const { user, game } = await openGame()
    const a = firstEmptyIndex(game)
    const wrong = wrongButLegal(game, a)
    await user.click(cell(a))
    await user.keyboard(String(wrong))
    await user.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByText(/1 incorrect cell is marked/)).toBeInTheDocument()
    expect(cell(a)).toHaveAccessibleName(/incorrect/)
    expect(within(cell(a)).getByText('✕')).toBeInTheDocument()
    expect(serverGame(game.id).mistakes).toBe(1)
  })

  it('completes the game, shows the score and locks the board', async () => {
    const puzzleSeed = seedGameShape()
    const { user, game } = await openGame(puzzleSeed)
    const last = firstEmptyIndex(game)
    await user.click(cell(last))
    await user.keyboard(game.solution[last]!)
    const dialog = await screen.findByRole('dialog', { name: 'Puzzle solved!' }, { timeout: 3000 })
    const score = serverGame(game.id).score
    expect(serverGame(game.id).status).toBe('completed')
    expect(dialog.querySelector('.completion__score-value')).toHaveTextContent(String(score))
    const breakdown = within(dialog).getByRole('table', { name: 'Score breakdown' })
    expect(
      within(breakdown).getByRole('rowheader', { name: /Time bonus ×1\.50/ }),
    ).toBeInTheDocument()
    expect(within(breakdown).getByRole('row', { name: /Total/ })).toHaveTextContent(String(score))
    expect(within(dialog).getByRole('link', { name: 'View leaderboard' })).toHaveAttribute(
      'href',
      '/leaderboard?difficulty=easy',
    )
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('grid')).toHaveAttribute('aria-readonly', 'true')
    expect(screen.getByRole('button', { name: /^Enter 1,/ })).toBeDisabled()
  })

  it('tells the user when the server says the board is not solved', async () => {
    server.use(
      http.post('*/api/v1/games/:id/complete', () =>
        HttpResponse.json(
          { detail: 'The board is not correctly solved yet', code: 'board_not_solved' },
          { status: 422 },
        ),
      ),
    )
    const { user, game } = await openGame(seedGameShape())
    const last = firstEmptyIndex(game)
    await user.click(cell(last))
    await user.keyboard(game.solution[last]!)
    expect(
      await screen.findByText(/something isn't right/, {}, { timeout: 3000 }),
    ).toBeInTheDocument()
  })

  it('pauses: hides the digits and stops input', async () => {
    const { user, game } = await openGame()
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    const givenIndex = [...game.givens].findIndex((c) => c !== '0')
    expect(cell(givenIndex)).toHaveAccessibleName(`${cellLabelPrefix(givenIndex)} empty`)
    expect(screen.getByRole('button', { name: /^Enter 1,/ })).toBeDisabled()
    await user.click(screen.getAllByRole('button', { name: 'Resume' })[0]!)
    expect(cell(givenIndex)).toHaveAccessibleName(/given/)
  })

  it('shows not found for someone else’s game', async () => {
    await loginAsDemo()
    const other = db.games.find((g) => g.user_id !== db.users[0]!.id)!
    renderApp(`/game/${other.id}`)
    expect(await screen.findByText('Game not found')).toBeInTheDocument()
  })
})

/** Board with all but one non-given cell already solved. */
function seedGameShape(): Partial<MockGame> {
  const base = seedGame()
  db.games.pop()
  const empty = firstEmptyIndex(base)
  const current = [...base.solution]
  current[empty] = '0'
  return { givens: base.givens, solution: base.solution, current: current.join('') }
}
