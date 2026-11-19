import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

/**
 * Regression for the reload-time PATCH 409s, against the real backend
 * (EMAIL_BACKEND=console; E2E_EMAIL_LOG is the API log):
 * edit, then reload at the worst moments — immediately, inside the 1 s
 * autosave debounce, while the debounced PATCH is in flight, and after it.
 * Every reload must cause zero 409s and show exactly the last edit.
 *
 *   E2E_BASE_URL=http://localhost:5173 E2E_EMAIL_LOG=/path/api.log \
 *     npx playwright test real-backend-reload --project=chromium
 */
const apiLog = process.env.E2E_EMAIL_LOG

test.skip(!apiLog || !process.env.E2E_BASE_URL, 'needs E2E_BASE_URL and E2E_EMAIL_LOG')
test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'desktop only')

/** Complete lines of the API log (no trailing empty entry). */
const logLines = () => readFileSync(apiLog!, 'utf8').split('\n').slice(0, -1)

function verifyLinkFor(address: string): string | null {
  const log = readFileSync(apiLog!, 'utf8')
  const start = log.lastIndexOf(`to=${address}`)
  if (start < 0) return null
  return /https?:\/\/\S+\/verify-email\?token=[\w-]+/.exec(log.slice(start))?.[0] ?? null
}

/** ms between the last edit and the reload; ~1000 hits the in-flight debounced PATCH. */
const DELAYS = [0, 150, 500, 900, 990, 1000, 1005, 1015, 1100, 1600]

test('reloading at the worst moments never conflicts or loses the last edit', async ({ page }) => {
  test.setTimeout(120_000)
  const name = `rl_${Date.now().toString(36)}`
  const email = `${name}@example.com`
  await page.goto('/register')
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect.poll(() => verifyLinkFor(email), { timeout: 10_000 }).not.toBeNull()
  const link = new URL(verifyLinkFor(email)!)
  await page.goto(link.pathname + link.search)
  await page.goto('/login')
  await page.getByLabel('Email or username').fill(name)
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByRole('button', { name: /^Beginner/ }).click()
  const grid = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(grid).toBeVisible({ timeout: 30_000 })
  const gameId = /\/game\/(\d+)/.exec(page.url())![1]
  const patchFor = new RegExp(`"PATCH /api/v1/games/${gameId} HTTP/1.1" (\\d{3})`)

  const empty = grid.getByRole('gridcell', { name: /, empty$/ }).first()
  const prefix = (await empty.getAttribute('aria-label'))!.replace(/ empty$/, '')
  const cell = grid.getByRole('gridcell', { name: new RegExp(`^${prefix}`) })

  for (const [i, delay] of DELAYS.entries()) {
    const from = logLines().length
    const digit = (i % 9) + 1
    await cell.click()
    await page.keyboard.press('n')
    await page.keyboard.press(String(digit))
    await page.keyboard.press('n')
    const edited = await cell.getAttribute('aria-label')
    await page.waitForTimeout(delay)
    await page.reload()
    await expect(grid).toBeVisible()

    // The reloaded page shows the server's state: it must be the last edit.
    await expect(cell, `reload ${i + 1} after ${delay} ms`).toHaveAttribute('aria-label', edited!)
    // And no PATCH for this game was rejected.
    const statuses = logLines()
      .slice(from)
      .map((l) => patchFor.exec(l)?.[1])
      .filter((s): s is string => s !== undefined)
    expect(statuses.length, `reload ${i + 1}: the edit was saved`).toBeGreaterThan(0)
    expect(
      statuses.filter((s) => s !== '200'),
      `reload ${i + 1} after ${delay} ms`,
    ).toEqual([])
  }
})
