import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { computeScore, db } from '../../mocks/db'
import { demoUserId, loginAsDemo, renderApp, seedGame } from '../../test/utils'

describe('LeaderboardPage', () => {
  it('works logged out and never shows email addresses', async () => {
    const { container } = renderApp('/leaderboard?difficulty=hard&period=all')
    const table = await screen.findByRole('table', { name: /Hard leaderboard, All time/ })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.length).toBeGreaterThan(0)
    expect(within(rows[0]!).getByText('1')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/@/)
    // Unverified users never appear.
    expect(screen.queryByText('unverified_user')).not.toBeInTheDocument()
    expect(screen.queryByText(/Your rank/)).not.toBeInTheDocument()
  })

  it('filters by difficulty and period via the URL', async () => {
    const { user, router } = renderApp('/leaderboard')
    await screen.findByRole('table')
    await user.selectOptions(screen.getByLabelText('Difficulty'), 'expert')
    await waitFor(() => expect(router.state.location.search).toContain('difficulty=expert'))
    expect(await screen.findByRole('table', { name: /Expert leaderboard/ })).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'All time' }))
    expect(router.state.location.search).toContain('period=all')
    expect(await screen.findByRole('table', { name: /All time/ })).toBeInTheDocument()
  })

  it("highlights the logged-in user's own rank", async () => {
    await loginAsDemo()
    const game = seedGame({ difficulty: 'beginner' })
    Object.assign(game, {
      status: 'completed',
      elapsed_seconds: 60,
      completed_at: new Date().toISOString(),
    })
    game.score = computeScore(game).total + 1000 // make sure it ranks first
    expect(game.user_id).toBe(demoUserId())

    renderApp('/leaderboard?difficulty=beginner&period=day')
    expect(await screen.findByText(/Your rank: #1 of \d+/)).toBeInTheDocument()
    const mine = screen.getByText('You').closest('tr')!
    expect(mine).toHaveAttribute('aria-current', 'true')
    expect(within(mine).getByText('demo')).toBeInTheDocument()
  })

  it('defaults to all levels and shows a level column', async () => {
    renderApp('/leaderboard?period=all')
    const table = await screen.findByRole('table', { name: /All levels leaderboard/ })
    expect(within(table).getByRole('columnheader', { name: 'Level' })).toBeInTheDocument()
    expect(screen.getByLabelText('Difficulty')).toHaveValue('all')
  })

  it('tells a logged-in user without a score', async () => {
    await loginAsDemo()
    renderApp('/leaderboard?difficulty=extreme&period=day')
    expect(await screen.findByText(/don't have a ranked Extreme score/)).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    db.games = []
    renderApp('/leaderboard?difficulty=easy&period=day')
    expect(await screen.findByText(/No scores yet for Easy/)).toBeInTheDocument()
  })

  it('explains that imported games are not ranked, and never lists them', async () => {
    await loginAsDemo()
    const imported = seedGame({
      source: 'imported',
      difficulty: 'easy',
      status: 'completed',
      score: 999_999,
      completed_at: new Date().toISOString(),
    })
    renderApp('/leaderboard?difficulty=easy&period=all')
    expect(await screen.findByText(/imported from a photo aren't ranked/)).toBeInTheDocument()
    const table = await screen.findByRole('table')
    expect(within(table).queryByText('999,999')).not.toBeInTheDocument()
    expect(imported.source).toBe('imported')
  })
})
