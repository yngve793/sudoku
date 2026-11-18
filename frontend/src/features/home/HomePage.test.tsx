import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DIFFICULTIES } from '../../api/types'
import { DIFFICULTY_INFO } from '../../lib/difficulties'
import { http, HttpResponse } from 'msw'
import { db } from '../../mocks/db'
import { server } from '../../mocks/node'
import { loginAsDemo, renderApp, seedGame } from '../../test/utils'

describe('HomePage', () => {
  it('shows a landing page when logged out', async () => {
    renderApp('/')
    expect(
      await screen.findByRole('heading', { name: /Sudoku that teaches you to think/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create a free account' })).toHaveAttribute(
      'href',
      '/register',
    )
  })

  it('lists all seven difficulties with technique descriptions', async () => {
    await loginAsDemo()
    renderApp('/')
    const section = await screen.findByRole('region', { name: 'New game' })
    const buttons = within(section).getAllByRole('button')
    expect(buttons).toHaveLength(7)
    DIFFICULTIES.forEach((d, i) => {
      expect(buttons[i]).toHaveAccessibleName(new RegExp(DIFFICULTY_INFO[d].label))
      expect(buttons[i]).toHaveAccessibleDescription(new RegExp(DIFFICULTY_INFO[d].techniques))
    })
  })

  it('starts a new game and opens the board', async () => {
    await loginAsDemo()
    const { user, router } = renderApp('/')
    await user.click(await screen.findByRole('button', { name: /^Hard/ }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/game\/\d+$/))
    expect(await screen.findByRole('grid', { name: 'Sudoku board' })).toBeInTheDocument()
    expect(db.games.at(-1)?.difficulty).toBe('hard')
  })

  it('shows a friendly message when no puzzle is available (503)', async () => {
    server.use(
      http.post('*/api/v1/games', () =>
        HttpResponse.json(
          { detail: 'Could not produce a puzzle, please retry', code: 'puzzle_unavailable' },
          { status: 503 },
        ),
      ),
    )
    await loginAsDemo()
    const { user } = renderApp('/')
    await user.click(await screen.findByRole('button', { name: /^Extreme/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/No puzzle is ready for this level/)
  })

  it('offers resume and confirms before abandoning the current game', async () => {
    await loginAsDemo()
    const current = seedGame()
    const { user, router } = renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Continue your game' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Resume' })).toHaveAttribute(
      'href',
      `/game/${current.id}`,
    )

    await user.click(screen.getByRole('button', { name: /^Medium/ }))
    const dialog = screen.getByRole('dialog', { name: 'Start a new game?' })
    await user.click(within(dialog).getByRole('button', { name: 'Keep playing' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Medium/ }))
    await user.click(screen.getByRole('button', { name: 'Start new game' }))
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/'))
    expect(current.status).toBe('abandoned')
  })

  it('shows personal stats', async () => {
    await loginAsDemo()
    seedGame()
    renderApp('/')
    const stats = await screen.findByRole('region', { name: 'Your stats' })
    expect(within(stats).getByText('Games started')).toBeInTheDocument()
    expect(await within(stats).findByText('1')).toBeInTheDocument()
    expect(await within(stats).findByRole('table')).toBeInTheDocument()
  })
})
