import { expect, test, type Page } from '@playwright/test'

/**
 * Smoke test against the MSW-mocked dev server: the mock "mailer" prints
 * verification links to the browser console, which stands in for Mailpit.
 */
function captureEmailLinks(page: Page): string[] {
  const links: string[] = []
  page.on('console', (msg) => {
    const match = /\[mock email\] verify_email for \S+: (\S+)/.exec(msg.text())
    if (match?.[1]) links.push(match[1])
  })
  return links
}

test('public leaderboard works logged out', async ({ page }) => {
  await page.goto('/leaderboard?difficulty=hard&period=all')
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('@')
})

test('register -> verify -> play -> hint -> leaderboard', async ({ page }) => {
  const links = captureEmailLinks(page)
  const name = `e2e_${Date.now().toString(36)}`.slice(0, 20)
  const email = `${name}@example.com`

  await page.goto('/register')
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  await expect.poll(() => links.length).toBeGreaterThan(0)
  await page.goto(links[0]!)
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible()

  await page.getByRole('main').getByRole('link', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.getByLabel('Email or username').fill(email)
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible()

  await page.getByRole('button', { name: /^Beginner/ }).click()
  const grid = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(grid).toBeVisible()

  // Play a move with the keyboard.
  const empty = grid.getByRole('gridcell', { name: /, empty$/ }).first()
  const label = (await empty.getAttribute('aria-label'))!
  const prefix = label.replace(/ empty$/, '')
  await empty.click()
  await page.keyboard.press('n')
  await page.keyboard.press('5')
  await expect(grid.getByRole('gridcell', { name: `${prefix} empty, notes 5` })).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })

  // Staged hint with visible cost.
  await page.getByRole('button', { name: 'Hint' }).click()
  const panel = page.getByRole('region', { name: 'Hint' })
  await panel.getByRole('button', { name: /Show technique and region \(−\d+ points\)/ }).click()
  await expect(
    panel.getByRole('button', { name: /Highlight the cells \(−\d+ points\)/ }),
  ).toBeVisible()
  await expect(page.getByRole('gridcell', { name: /, hint$/ }).first()).toBeVisible()

  // Reload: session restored from the refresh cookie, board and notes resumed.
  await page.reload()
  await expect(grid.getByRole('gridcell', { name: `${prefix} empty, notes 5` })).toBeVisible()

  await page.getByRole('link', { name: 'Leaderboard' }).click()
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /rank/ })).toBeVisible()
})
