import { expect, test, type Locator } from '@playwright/test'
import { candidates, findContradiction } from '../src/features/search/constraints'

/**
 * Search mode against the MSW-mocked dev server:
 * enter search → guess → contradiction ✗ → apply a live branch.
 */

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

test('search: guess, contradiction, apply a live branch', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email or username').fill('demo')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByRole('button', { name: /^Beginner/ }).click()
  const grid = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(grid).toBeVisible()
  const board = await readBoard(grid)

  // A cell and a digit that duplicates a given in its row: a contradiction.
  const target = board.findIndex((v, i) => v === 0 && candidates(board, i).length > 0)
  const row = Math.floor(target / 9)
  const rowDigits = board.slice(row * 9, row * 9 + 9).filter(Boolean)
  const bad = rowDigits[0]!
  const live = candidates(board, target).find((v) => {
    const next = board.slice()
    next[target] = v
    return findContradiction(next) === null
  })!

  // Enter search mode with the S key.
  await grid.getByRole('gridcell', { name: new RegExp(`^${cellName(target)}`) }).click()
  await page.keyboard.press('s')
  const searchGrid = page.getByRole('grid', { name: 'Search board, Start' })
  await expect(searchGrid).toBeVisible()
  const tree = page.getByRole('tree', { name: 'Search tree' })
  await expect(tree.getByRole('treeitem')).toHaveCount(1)

  // Guess the clashing digit: the node is dead and drawn with a cross.
  await page.keyboard.press('g')
  await page.keyboard.press(String(bad))
  const dead = tree.getByRole('treeitem', { name: /, dead: .* appears twice in row/ })
  await expect(dead).toBeVisible()
  await expect(dead.locator('.graph-node__cross')).toHaveCount(1)
  await expect(page.getByRole('gridcell', { name: /, contradiction$/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply branch' })).toBeDisabled()

  // Back to the root (click in the graph), guess a live digit and apply it.
  await tree.getByRole('treeitem', { name: /^Start position/ }).click()
  await page
    .getByRole('grid', { name: 'Search board, Start' })
    .getByRole('gridcell', { name: new RegExp(`^${cellName(target)}`) })
    .click()
  await page.getByRole('button', { name: 'Guess…' }).click()
  await page.getByRole('button', { name: new RegExp(`^Guess ${live},`) }).click()
  const liveNode = tree.getByRole('treeitem', { selected: true })
  await expect(liveNode).not.toHaveAccessibleName(/dead/)
  await expect(tree.getByRole('treeitem')).toHaveCount(3)

  // A manual placement in the live node becomes its own node in the chain.
  const after = board.slice()
  after[target] = live
  // A (cell, digit) that keeps the node consistent, so it can still be applied.
  const [other, otherValue] = after
    .flatMap((v, i) => (v === 0 ? candidates(after, i).map((d) => [i, d] as const) : []))
    .find(([i, d]) => {
      const next = after.slice()
      next[i] = d
      return findContradiction(next) === null
    })!
  await page
    .getByRole('grid')
    .getByRole('gridcell', { name: new RegExp(`^${cellName(other)}`) })
    .click()
  await page.keyboard.press(String(otherValue))
  const step = tree.getByRole('treeitem', { name: /, placed manually, step 1 of 1 after / })
  await expect(step).toBeVisible()
  await expect(step).toHaveAttribute('data-kind', 'manual')
  await expect(step).toHaveAttribute('aria-selected', 'true')
  await expect(tree.getByRole('treeitem')).toHaveCount(4)
  await page.getByRole('button', { name: 'Apply branch' }).click()

  await expect(grid).toBeVisible()
  await expect(
    grid.getByRole('gridcell', { name: new RegExp(`^${cellName(target)} ${live}$`) }),
  ).toBeVisible()
  await expect(page.getByText(/Applied 2 cells from r\dc\d=\d to the board/).first()).toBeVisible()
  // One undo reverts the whole branch.
  await page.keyboard.press('Control+z')
  await expect(
    grid.getByRole('gridcell', { name: new RegExp(`^${cellName(target)} empty$`) }),
  ).toBeVisible()
})
