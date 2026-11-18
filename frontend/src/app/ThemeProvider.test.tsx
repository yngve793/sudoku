import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../test/utils'

describe('theme toggle', () => {
  afterEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
  })

  it('cycles auto -> dark -> light -> auto and remembers the choice', async () => {
    const { user } = renderApp('/leaderboard')
    const button = await screen.findByRole('button', { name: /Colour theme: Auto/ })
    await user.click(button)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('sudoku.theme')).toBe('dark')
    await user.click(screen.getByRole('button', { name: /Colour theme: Dark/ }))
    expect(document.documentElement.dataset.theme).toBe('light')
    await user.click(screen.getByRole('button', { name: /Colour theme: Light/ }))
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(localStorage.getItem('sudoku.theme')).toBeNull()
  })
})
