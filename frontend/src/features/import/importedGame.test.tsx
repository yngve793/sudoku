import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { loginAsDemo, renderApp, seedGame } from '../../test/utils'

describe('imported games elsewhere in the app', () => {
  it('shows "Unrated" and "Imported" in the game header', async () => {
    await loginAsDemo()
    const game = seedGame({ source: 'imported', difficulty: null })
    renderApp(`/game/${game.id}`)
    const heading = await screen.findByRole('heading', { level: 1, name: /Unrated/ })
    expect(within(heading).getByText('Imported')).toBeInTheDocument()
  })

  it('shows badges in the resume card and the recent games list', async () => {
    await loginAsDemo()
    seedGame({ source: 'imported', difficulty: null })
    renderApp('/')
    const resume = await screen.findByRole('region', { name: 'Continue your game' })
    expect(within(resume).getByText('Unrated')).toBeInTheDocument()
    expect(within(resume).getByText('Imported')).toBeInTheDocument()
    const recent = await screen.findByRole('heading', { name: 'Recent games' })
    const list = recent.nextElementSibling as HTMLElement
    expect(within(list).getByText('Imported')).toBeInTheDocument()
    expect(within(list).getByText(/In progress/)).toBeInTheDocument()
  })

  it('offers the import entry point on the home screen', async () => {
    await loginAsDemo()
    renderApp('/')
    const section = await screen.findByRole('region', { name: 'New game' })
    expect(within(section).getByRole('link', { name: 'Import from photo' })).toHaveAttribute(
      'href',
      '/import',
    )
  })
})
