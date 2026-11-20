import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { IMPORT_GIVENS, IMPORT_SOLUTION } from '../src/mocks/imports'

/**
 * Photo import against the real backend (EMAIL_BACKEND=console).
 *
 * - check + import + play run whenever the backend is up;
 * - recognition reads the vision agent's synthetic fixture
 *   `vision/tests/fixtures/synth_7_00.jpg` (read-only) and must match its labels exactly.
 *
 *   E2E_BASE_URL=http://localhost:5173 E2E_EMAIL_LOG=/path/api.log \
 *     npx playwright test real-backend-import --project=chromium
 */
const emailLog = process.env.E2E_EMAIL_LOG

test.skip(!emailLog || !process.env.E2E_BASE_URL, 'needs E2E_BASE_URL and E2E_EMAIL_LOG')
test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'desktop only')

const PASSWORD = 'correct-horse-battery'

function verifyLinkFor(address: string): string | null {
  const log = readFileSync(emailLog!, 'utf8')
  const start = log.lastIndexOf(`to=${address}`)
  if (start < 0) return null
  return /https?:\/\/\S+\/verify-email\?token=[\w-]+/.exec(log.slice(start))?.[0] ?? null
}

/** Registers, verifies and logs in through the UI; returns the username. */
async function signUp(page: Page, prefix: string): Promise<string> {
  const name = `${prefix}_${Date.now().toString(36)}`
  const email = `${name}@example.com`
  await page.goto('/register')
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect.poll(() => verifyLinkFor(email), { timeout: 10_000 }).not.toBeNull()
  const link = new URL(verifyLinkFor(email)!)
  await page.goto(link.pathname + link.search)
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible()
  await page.goto('/login')
  await page.getByLabel('Email or username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible()
  return name
}

/** A second session for direct API calls (the app keeps its token in memory only). */
async function apiToken(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/v1/auth/login', {
    data: { email: name, password: PASSWORD },
  })
  expect(res.status()).toBe(200)
  return ((await res.json()) as { access_token: string }).access_token
}

/** Synthetic labelled photo from the vision agent (read-only). */
const FIXTURE = fileURLToPath(
  new URL('../../vision/tests/fixtures/synth_7_00.jpg', import.meta.url),
)
interface FixtureLabels {
  /** 81 chars, '.' = none. */
  givens: string
  handwritten: string
}
const labels = JSON.parse(readFileSync(FIXTURE.replace(/\.jpg$/, '.json'), 'utf8')) as FixtureLabels

const cellPrefix = (i: number) => `Row ${Math.floor(i / 9) + 1}, column ${(i % 9) + 1}, `

/** Review-grid label we expect for a cell, without the trailing review flags. */
function expectedReview(i: number): string {
  const g = labels.givens[i]!
  const h = labels.handwritten[i]!
  if (g !== '.') return `${g}, given`
  if (h !== '.') return `${h}, handwritten`
  return 'empty'
}

test('check and import a reviewed board, then play it (no recognition)', async ({ page }) => {
  test.setTimeout(90_000)
  const name = await signUp(page, 'im')
  const token = await apiToken(page, name)
  const auth = { Authorization: `Bearer ${token}` }

  // A handwritten entry that clashes with a given: inconsistent, but the givens are unique.
  const clash = '5' + IMPORT_GIVENS.slice(1, 2) + '9' + IMPORT_GIVENS.slice(3)
  const check = await page.request.post('/api/v1/imports/check', {
    headers: auth,
    data: { givens: IMPORT_GIVENS, current: clash },
  })
  expect(check.status()).toBe(200)
  const body = (await check.json()) as Record<string, unknown>
  expect(body).toMatchObject({ consistent: false, solution_count: 1 })
  expect(body).not.toHaveProperty('solution')

  const sparse = IMPORT_GIVENS.slice(0, 27) + '0'.repeat(54)
  const many = await page.request.post('/api/v1/games/import', {
    headers: auth,
    data: { givens: sparse, current: sparse },
  })
  expect(many.status()).toBe(422)
  expect(((await many.json()) as { code: string }).code).toBe('multiple_solutions')

  const current = IMPORT_GIVENS.slice(0, 2) + '4' + IMPORT_GIVENS.slice(3)
  const created = await page.request.post('/api/v1/games/import', {
    headers: auth,
    data: { givens: IMPORT_GIVENS, current },
  })
  expect(created.status()).toBe(201)
  const game = (await created.json()) as { id: number; source: string; version: number }
  expect(game.source).toBe('imported')

  // The app shows it as an imported game and it plays like any other.
  await page.goto(`/game/${game.id}`)
  const board = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(board).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Imported')
  await expect(board.getByRole('gridcell', { name: 'Row 1, column 3, 4' })).toBeVisible()

  // Finish it via the API: it counts in the history but is never ranked.
  const saved = await page.request.patch(`/api/v1/games/${game.id}`, {
    headers: auth,
    data: { current: IMPORT_SOLUTION, notes: {}, elapsed_seconds: 30, version: game.version },
  })
  expect(saved.status()).toBe(200)
  expect(
    (await page.request.post(`/api/v1/games/${game.id}/complete`, { headers: auth })).status(),
  ).toBe(200)
  const scores = (await (
    await page.request.get('/api/v1/scores/me', { headers: auth })
  ).json()) as { history: { game_id: number; source: string }[] }
  expect(scores.history.find((h) => h.game_id === game.id)?.source).toBe('imported')
  const rank = (await (
    await page.request.get('/api/v1/leaderboard/me', { headers: auth })
  ).json()) as { rank: number | null }
  expect(rank.rank).toBeNull()
})

test('recognise the synthetic fixture photo, review, start and see the board', async ({ page }) => {
  test.setTimeout(120_000)
  await signUp(page, 'ir')
  await page.goto('/import')
  // Goes through the real browser preprocessing (orient, ≤ 2000 px, JPEG re-encode).
  await page.getByLabel('Photo file').setInputFiles(FIXTURE)
  await expect(page.getByRole('heading', { name: 'Check the puzzle' })).toBeVisible({
    timeout: 30_000,
  })
  const grid = page.getByRole('grid', { name: 'Recognised puzzle' })
  await expect(grid.getByRole('gridcell')).toHaveCount(81)

  // Exact match with the labels: every cell's digit and kind (flags may follow).
  const read = await grid
    .getByRole('gridcell')
    .evaluateAll((cells) => cells.map((c) => c.getAttribute('aria-label') ?? ''))
  const mismatches = read.flatMap((label, i) => {
    const want = cellPrefix(i) + expectedReview(i)
    return label === want || label.startsWith(`${want}, `) ? [] : [`${want}  <-  got "${label}"`]
  })
  expect(mismatches, 'recognised grid differs from the fixture labels').toEqual([])

  const start = page.getByRole('button', { name: 'Start game' })
  await expect(start).toBeEnabled({ timeout: 15_000 })
  await start.click()

  const board = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(board).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Imported')
  const played = await board
    .getByRole('gridcell')
    .evaluateAll((cells) => cells.map((c) => c.getAttribute('aria-label') ?? ''))
  played.forEach((label, i) => {
    const g = labels.givens[i]!
    const h = labels.handwritten[i]!
    // Givens are fixed; handwritten digits are the player's own entries.
    const want = cellPrefix(i) + (g !== '.' ? `${g}, given` : h !== '.' ? h : 'empty')
    expect(label === want || label.startsWith(`${want}, `), `${want} <- "${label}"`).toBe(true)
  })
})
