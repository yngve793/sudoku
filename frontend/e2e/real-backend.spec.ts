import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

/**
 * Runs against a real backend started with EMAIL_BACKEND=console. The
 * verification link is read from the API log file given in E2E_EMAIL_LOG.
 * (The Phase 4 suite will read Mailpit's API instead.)
 *
 *   E2E_BASE_URL=http://localhost:5173 E2E_EMAIL_LOG=/path/api.log npx playwright test real-backend
 */
const emailLog = process.env.E2E_EMAIL_LOG

test.skip(!emailLog || !process.env.E2E_BASE_URL, 'needs E2E_BASE_URL and E2E_EMAIL_LOG')
// The backend rate-limits /auth/* per IP (20/min); one browser project is enough here.
test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'desktop only')

function verifyLinkFor(address: string): string | null {
  const log = readFileSync(emailLog!, 'utf8')
  const start = log.lastIndexOf(`to=${address}`)
  if (start < 0) return null
  return /https?:\/\/\S+\/verify-email\?token=[\w-]+/.exec(log.slice(start))?.[0] ?? null
}

test('register -> verify -> play -> hint -> check against the real API', async ({ page }) => {
  const name = `it_${Date.now().toString(36)}`
  const email = `${name}@example.com`
  const password = 'correct-horse-battery'

  await page.goto('/register')
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  // Unverified login is refused with an inline prompt.
  await page.goto('/login')
  await page.getByLabel('Email or username').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByText('Please verify your email')).toBeVisible()

  await expect.poll(() => verifyLinkFor(email), { timeout: 10_000 }).not.toBeNull()
  const link = new URL(verifyLinkFor(email)!)
  await page.goto(link.pathname + link.search)
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible()

  // Log in with the username this time.
  await page.goto('/login')
  await page.getByLabel('Email or username').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible()

  await page.getByRole('button', { name: /^Beginner/ }).click()
  const grid = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(grid).toBeVisible({ timeout: 30_000 })
  await expect(grid.getByRole('gridcell')).toHaveCount(81)

  // Notes, then autosave (PATCH with version).
  const empty = grid.getByRole('gridcell', { name: /, empty$/ }).first()
  const prefix = (await empty.getAttribute('aria-label'))!.replace(/ empty$/, '')
  await empty.click()
  await page.keyboard.press('n')
  await page.keyboard.press('3')
  await page.keyboard.press('n')
  await expect(grid.getByRole('gridcell', { name: `${prefix} empty, notes 3` })).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })

  // Three hint stages with costs from the server (10/20/40), then fill in.
  await page.keyboard.press('h')
  const panel = page.getByRole('region', { name: 'Hint' })
  await panel.getByRole('button', { name: 'Show technique and region (−10 points)' }).click()
  await expect(
    panel.getByRole('button', { name: 'Highlight the cells (−20 points)' }),
  ).toBeVisible()
  await expect(page.getByRole('gridcell', { name: /, hint$/ })).toHaveCount(9)
  await panel.getByRole('button', { name: 'Highlight the cells (−20 points)' }).click()
  await panel.getByRole('button', { name: 'Reveal the value (−40 points)' }).click()
  const fill = panel.getByRole('button', { name: /^Fill in \d at r\dc\d$/ })
  await expect(fill).toBeVisible()
  await fill.click()
  await expect(page.locator('.stat', { hasText: 'Hints' })).toContainText('3')

  // Place a wrong digit somewhere and check.
  const target = grid.getByRole('gridcell', { name: /, empty$/ }).first()
  await target.click()
  let marked = false
  for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    await page.keyboard.press(digit)
    const label = (await target.getAttribute('aria-label')) ?? ''
    if (!label.includes('conflict')) {
      marked = true
      break
    }
  }
  expect(marked).toBe(true)
  await page.getByRole('button', { name: 'Check' }).click()
  await expect(page.getByText(/No mistakes so far|incorrect cells? (is|are) marked/)).toBeVisible()

  // Reload: session from the refresh cookie, board and notes resumed. (The hint
  // may have filled the noted cell, so compare with its label before reloading.)
  const notedCell = grid.getByRole('gridcell', { name: new RegExp(`^${prefix} `) })
  const before = await notedCell.getAttribute('aria-label')
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })
  await page.reload()
  // "incorrect" marks from Check are session-only; everything else must survive.
  await expect(notedCell).toHaveAttribute('aria-label', before!.replace(/, incorrect$/, ''))

  await page.getByRole('link', { name: 'Leaderboard' }).click()
  await expect(page.getByRole('table').or(page.getByText(/No scores yet/))).toBeVisible()
})
