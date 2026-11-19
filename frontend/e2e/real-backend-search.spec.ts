import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { candidates, findContradiction } from '../src/features/search/constraints'

/**
 * Search mode against the real backend (EMAIL_BACKEND=console), proving the
 * server accepts the trees the client saves (strict `SearchTree` validation).
 *
 *   E2E_BASE_URL=http://localhost:5173 E2E_EMAIL_LOG=/path/api.log \
 *     npx playwright test real-backend-search --project=chromium
 */
const emailLog = process.env.E2E_EMAIL_LOG

test.skip(!emailLog || !process.env.E2E_BASE_URL, 'needs E2E_BASE_URL and E2E_EMAIL_LOG')
test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'desktop only')

function verifyLinkFor(address: string): string | null {
  const log = readFileSync(emailLog!, 'utf8')
  const start = log.lastIndexOf(`to=${address}`)
  if (start < 0) return null
  return /https?:\/\/\S+\/verify-email\?token=[\w-]+/.exec(log.slice(start))?.[0] ?? null
}

async function signUp(page: Page): Promise<void> {
  const name = `se_${Date.now().toString(36)}`
  const email = `${name}@example.com`
  const password = 'correct-horse-battery'
  await page.goto('/register')
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect.poll(() => verifyLinkFor(email), { timeout: 10_000 }).not.toBeNull()
  const link = new URL(verifyLinkFor(email)!)
  await page.goto(link.pathname + link.search)
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible()
  await page.goto('/login')
  await page.getByLabel('Email or username').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible()
}

async function readBoard(grid: Locator): Promise<number[]> {
  const labels = await grid
    .getByRole('gridcell')
    .evaluateAll((cells) => cells.map((c) => c.getAttribute('aria-label') ?? ''))
  return labels.map((label) => {
    const match = /^Row \d, column \d, (\d)/.exec(label)
    return match ? Number(match[1]) : 0
  })
}

const cellName = (i: number) => `Row ${Math.floor(i / 9) + 1}, column ${(i % 9) + 1},`

test('search mode round-trips through the real API', async ({ page }) => {
  test.setTimeout(90_000)
  // Every PATCH / propagate must succeed: a 422 means the client sent a bad tree.
  const failures: string[] = []
  const savedTrees: number[] = []
  page.on('response', async (res) => {
    const req = res.request()
    const isPatch = req.method() === 'PATCH' && /\/api\/v1\/games\/\d+$/.test(req.url())
    const isPropagate = req.url().endsWith('/search/propagate')
    if (!isPatch && !isPropagate) return
    if (res.status() >= 400)
      failures.push(
        `${req.method()} ${req.url()} -> ${res.status()} ${await res.text()}\n${req.postData() ?? ''}`,
      )
    else if (isPatch) {
      const body = JSON.parse(req.postData() ?? '{}') as {
        search_tree?: { nodes: unknown[] } | null
      }
      if (body.search_tree) savedTrees.push(body.search_tree.nodes.length)
    }
  })

  await signUp(page)
  await page.getByRole('button', { name: /^Beginner/ }).click()
  const grid = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(grid).toBeVisible({ timeout: 30_000 })
  const board = await readBoard(grid)
  const cell = (i: number) =>
    page.getByRole('grid').getByRole('gridcell', { name: new RegExp(`^${cellName(i)}`) })

  // 1. Enter search.
  await page.keyboard.press('s')
  await expect(page.getByRole('grid', { name: 'Search board, Start' })).toBeVisible()
  const tree = page.getByRole('tree', { name: 'Search tree' })

  // 2 + 5. Guess a digit that clashes with its row: contradiction ✗.
  const a = board.findIndex((v) => v === 0)
  const rowDigits = board.slice(Math.floor(a / 9) * 9, Math.floor(a / 9) * 9 + 9).filter(Boolean)
  await cell(a).click()
  await page.keyboard.press('g')
  await page.keyboard.press(String(rowDigits[0]))
  const dead = tree.getByRole('treeitem', { name: /, dead: .* appears twice in row/ })
  await expect(dead).toBeVisible()
  await expect(dead.locator('.graph-node__cross')).toHaveCount(1)
  await expect(page.getByRole('gridcell', { name: /, contradiction$/ }).first()).toBeVisible()

  // 4. Auto mode, after confirming its cost.
  await tree.getByRole('treeitem', { name: /^Start position/ }).click()
  await page.getByRole('radio', { name: /^Auto \(−2\/cell\)$/ }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Enable auto mode' })
  await expect(confirm).toContainText('Auto fills direct implications: −2 points per filled cell.')
  await confirm.getByRole('button', { name: 'Enable auto' }).click()

  // 3. Branch on all candidates of an empty cell with few options. On a
  //    beginner (singles-only) puzzle exactly one option propagates to a solution.
  const b = board
    .map((_v, i) => i)
    .filter((i) => i !== a && candidates(board, i).length >= 2)
    .sort((x, y) => candidates(board, x).length - candidates(board, y).length)[0]!
  const options = candidates(board, b)
  await cell(b).click()
  await page.keyboard.press('b')
  // Tree nodes = root + dead guess + one guess per option (implications are extra nodes).
  const guesses = tree.locator('[role="treeitem"][data-kind="guess"]')
  await expect(guesses).toHaveCount(1 + options.length)
  const solved = tree.getByRole('treeitem', { name: /, solved\.$/ })
  await expect(solved).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByText(/finding implications/)).toBeHidden({ timeout: 20_000 })
  const autoStat = page.locator('.stat', { hasText: 'Auto' })
  await expect(autoStat).toBeVisible()
  const auto = Number(/\d+/.exec(await autoStat.locator('dd').innerText())?.[0])
  expect(auto).toBeGreaterThan(0)
  // Every inferred value is its own graph node, labelled with its technique.
  // (Expanded layout shows every row; Fit renders everything near the view.)
  await page.getByRole('radio', { name: 'Expanded' }).click()
  await page.getByRole('button', { name: 'Fit' }).click()
  const implied = tree.getByRole('treeitem', { name: /, implied by (Naked|Hidden) Single, step / })
  await expect(implied).toHaveCount(auto)
  await expect(page.getByText(/^Auto placements:/)).toContainText(`${auto} (−${auto * 2} points)`)
  // Every auto node is consistent with the constraints the client checks.
  expect(findContradiction(board)).toBeNull()

  // 6. The tree reaches the server (autosave) and is restored after a reload.
  const total = 2 + options.length
  await expect.poll(() => savedTrees.at(-1), { timeout: 10_000 }).toBe(total)
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 10_000 })
  await page.reload()
  await expect(page.getByRole('grid', { name: 'Sudoku board' })).toBeVisible()
  await expect(page.locator('.stat', { hasText: 'Auto' })).toContainText(String(auto))
  await page.keyboard.press('s')
  await page.getByRole('button', { name: 'Fit' }).click()
  await expect(guesses).toHaveCount(total - 1)
  // Techniques are session-only: after a reload auto nodes fall back to "auto".
  await expect(tree.getByRole('treeitem', { name: /, implied \(auto\), step / })).toHaveCount(auto)
  await expect(
    tree.getByRole('treeitem', { name: /, dead: .* appears twice in row/ }),
  ).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: /, solved\.$/ })).toHaveCount(1)
  await expect(page.getByRole('radio', { name: /Auto \(−2\/cell\)/ })).toBeChecked()

  // The tree in its own tab: live through BroadcastChannel, same tree.
  const popupPromise = page.context().waitForEvent('page')
  await page.getByRole('button', { name: 'Open tree in new tab' }).click()
  const treeTab = await popupPromise
  await expect(treeTab.getByText(/Live: synced with the game tab/)).toBeVisible({ timeout: 15_000 })
  await treeTab.getByRole('button', { name: 'Fit' }).click()
  await expect(treeTab.locator('[role="treeitem"][data-kind="guess"]')).toHaveCount(total - 1)
  await treeTab.getByRole('treeitem', { name: /^Start position/ }).click()
  await expect(page.getByRole('grid', { name: 'Search board, Start' })).toBeVisible()
  await treeTab.close()

  // 7 + 8. Apply the solved (live) branch: the game completes and the
  //        breakdown includes the search penalty.
  await tree.getByRole('treeitem', { name: /, solved\.$/ }).click()
  await page.getByRole('button', { name: 'Apply branch' }).click()
  const dialog = page.getByRole('dialog', { name: 'Puzzle solved!' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  const breakdown = dialog.getByRole('table', { name: 'Score breakdown' })
  await expect(breakdown.getByRole('row', { name: /Search/ })).toContainText(`−${auto * 2}`)

  expect(failures).toEqual([])
})
