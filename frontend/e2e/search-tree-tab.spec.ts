import { expect, test } from '@playwright/test'
import { candidates, findContradiction } from '../src/features/search/constraints'

/**
 * The search tree in its own tab (mocked mode): two pages in one context,
 * synced through BroadcastChannel. The game tab is the single writer.
 */
const cellName = (i: number) => `Row ${Math.floor(i / 9) + 1}, column ${(i % 9) + 1},`

test('tree tab: select a step, guess there, and go read-only when the game closes', async ({
  page,
  context,
}) => {
  await page.goto('/login')
  await page.getByLabel('Email or username').fill('demo')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByRole('button', { name: /^Beginner/ }).click()
  const grid = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(grid).toBeVisible()
  const labels = await grid
    .getByRole('gridcell')
    .evaluateAll((cells) => cells.map((c) => c.getAttribute('aria-label') ?? ''))
  const board = labels.map((l) => Number(/^Row \d, column \d, (\d)/.exec(l)?.[1] ?? 0))

  // A live guess plus one consistent manual placement in the game tab.
  const pairs = board.flatMap((v, i) => (v ? [] : candidates(board, i).map((d) => [i, d] as const)))
  const ok = (b: number[], i: number, d: number) => {
    const n = b.slice()
    n[i] = d
    return findContradiction(n) === null
  }
  const [a, av] = pairs.find(([i, d]) => ok(board, i, d))!
  const after = board.slice()
  after[a] = av
  const [b, bv] = after
    .flatMap((v, i) => (v ? [] : candidates(after, i).map((d) => [i, d] as const)))
    .find(([i, d]) => ok(after, i, d))!
  await grid.getByRole('gridcell', { name: new RegExp(`^${cellName(a)}`) }).click()
  await page.keyboard.press('s')
  await page.keyboard.press('g')
  await page.keyboard.press(String(av))
  await page
    .getByRole('grid')
    .getByRole('gridcell', { name: new RegExp(`^${cellName(b)}`) })
    .click()
  await page.keyboard.press(String(bv))

  // Open the tree in a new tab.
  const popupPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Open tree in new tab' }).click()
  const treeTab = await popupPromise
  await treeTab.waitForLoadState()
  await expect(treeTab).toHaveURL(/\/game\/\d+\/tree$/)
  await expect(treeTab.getByText(/Live: synced with the game tab/)).toBeVisible()
  const tree = treeTab.getByRole('tree', { name: 'Search tree' })
  const guessLabel = new RegExp(`^r\\dc\\d equals ${av}, 1 implication`)
  await expect(tree.getByRole('treeitem', { name: guessLabel })).toBeVisible()

  // Select the guess step in the tree tab: the game board shows that step.
  await tree.getByRole('treeitem', { name: guessLabel }).click()
  await expect(
    page.getByRole('grid', { name: /^Search board, r\dc\d=\d, step 1 of 2$/ }),
  ).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: guessLabel })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  // Guess from the tree tab: the node appears in both tabs.
  const empty = after.findIndex((v, i) => v === 0 && i !== b)
  const row = Math.floor(empty / 9) + 1
  const col = (empty % 9) + 1
  await treeTab.getByLabel('Row').selectOption(String(row))
  await treeTab.getByLabel('Column').selectOption(String(col))
  const value = await treeTab.getByLabel('Value').inputValue()
  await treeTab.getByRole('button', { name: `Guess r${row}c${col}=${value}` }).click()
  const newNode = new RegExp(`^r${row}c${col} equals ${value}`)
  await expect(tree.getByRole('treeitem', { name: newNode })).toBeVisible()
  await expect(page.getByRole('tree').getByRole('treeitem', { name: newNode })).toBeVisible()
  await expect(
    page.getByRole('grid', { name: `Search board, r${row}c${col}=${value}` }),
  ).toBeVisible()

  // Closing the game tab turns the tree tab read-only (the tree stays visible).
  await page.close()
  await expect(treeTab.getByText(/No open game tab/)).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: newNode })).toBeVisible()
  await expect(treeTab.getByRole('button', { name: /^Delete branch/ })).toBeDisabled()
  await expect(treeTab.getByRole('button', { name: 'Reload saved tree' })).toBeVisible()
})
