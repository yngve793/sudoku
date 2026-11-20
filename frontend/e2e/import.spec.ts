import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { IMPORT_SOLUTION, MISREAD_CELL } from '../src/mocks/imports'

/**
 * Photo import against the MSW-mocked dev server: real client preprocessing
 * (createImageBitmap + canvas re-encode) → mocked recognition → review → fix a
 * misread cell → start → play to completion.
 */
const PHOTO = fileURLToPath(new URL('./fixtures/sudoku-photo.jpg', import.meta.url))
const cellName = (i: number) => `Row ${Math.floor(i / 9) + 1}, column ${(i % 9) + 1},`

test('import a photo, fix a cell, start and play', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email or username').fill('demo')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Log in' }).click()

  await page.getByRole('link', { name: 'Import from photo' }).click()
  await expect(page.getByRole('heading', { name: 'Import from photo' })).toBeVisible()
  await page.getByLabel('Photo file').setInputFiles(PHOTO)

  await expect(page.getByRole('heading', { name: 'Check the puzzle' })).toBeVisible()
  // The fixture is 800×640; corners are reported in the re-encoded image's pixels.
  const topLeft = page.getByRole('button', { name: /^Top-left corner/ })
  const label = (await topLeft.getAttribute('aria-label'))!
  const [x, y] = /x (\d+), y (\d+)/.exec(label)!.slice(1).map(Number)
  expect(x).toBeGreaterThan(0)
  expect(x).toBeLessThan(800)
  expect(y).toBeLessThan(640)

  const grid = page.getByRole('grid', { name: 'Recognised puzzle' })
  const misread = grid.getByRole('gridcell', { name: new RegExp(`^${cellName(MISREAD_CELL)}`) })
  await expect(misread).toHaveAccessibleName(/9, handwritten, low confidence.*contradiction/)
  // Only a handwritten entry conflicts: Start is allowed, with a non-blocking warning.
  const start = page.getByRole('button', { name: 'Start game' })
  await expect(start).toBeEnabled()
  const warning = page.getByText(
    'Your handwritten entries contain a conflict. You can fix it now or after starting.',
  )
  await expect(warning).toBeVisible()

  await misread.click()
  await page.getByRole('button', { name: 'Use 4 (38%)' }).click()
  await expect(misread).toHaveAccessibleName(`${cellName(MISREAD_CELL)} 4, handwritten`)
  await expect(page.locator('.check-status').getByText('No conflicts')).toBeVisible()
  await expect(start).toBeEnabled()
  await expect(warning).toBeHidden()

  // Keyboard: nudge a corner (Re-detect becomes available), then put it back.
  await topLeft.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('button', { name: 'Re-detect' })).toBeEnabled()
  await page.getByRole('button', { name: 'Reset corners' }).click()

  await start.click()
  const board = page.getByRole('grid', { name: 'Sudoku board' })
  await expect(board).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Imported')

  // Play: fill every empty cell with the (mock) solution.
  const labels = await board
    .getByRole('gridcell')
    .evaluateAll((cells) => cells.map((c) => c.getAttribute('aria-label') ?? ''))
  const empty = labels.flatMap((l, i) => (l.endsWith(', empty') ? [i] : []))
  expect(empty.length).toBeGreaterThan(30)
  await board.getByRole('gridcell', { name: new RegExp(`^${cellName(empty[0]!)}`) }).click()
  for (const i of empty) {
    await board.getByRole('gridcell', { name: new RegExp(`^${cellName(i)}`) }).focus()
    await page.keyboard.press(IMPORT_SOLUTION[i]!)
  }
  const dialog = page.getByRole('dialog', { name: 'Puzzle solved!' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByText(/not ranked/)).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Import another photo' })).toBeVisible()
})

test('preprocessing strips EXIF and downscales to 2000 px in a real browser', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'imports a source module from the Vite dev server')
  await page.goto('/')
  const fixture = [...(await import('node:fs')).readFileSync(PHOTO)]
  const result = await page.evaluate(async (bytes) => {
    const mod = (await import(
      /* @vite-ignore */ `${location.origin}/src/features/import/preprocess.ts`
    )) as typeof import('../src/features/import/preprocess')
    const ascii = async (blob: Blob) =>
      String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()))
    const original = new File([new Uint8Array(bytes)], 'photo.jpg', { type: 'image/jpeg' })
    const small = await mod.preprocessImage(original)
    // A large PNG: 4000×3000 drawn on a canvas.
    const canvas = document.createElement('canvas')
    canvas.width = 4000
    canvas.height = 3000
    canvas.getContext('2d')!.fillRect(0, 0, 100, 100)
    const png = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))
    const large = await mod.preprocessImage(new File([png], 'big.png', { type: 'image/png' }))
    return {
      originalHasExif: (await ascii(original)).includes('Exif'),
      small: { w: small.width, h: small.height, type: small.blob.type },
      smallHasExif: (await ascii(small.blob)).includes('Exif'),
      large: { w: large.width, h: large.height },
    }
  }, fixture)
  expect(result.originalHasExif).toBe(true)
  expect(result.smallHasExif).toBe(false)
  expect(result.small).toEqual({ w: 800, h: 640, type: 'image/jpeg' })
  expect(result.large).toEqual({ w: 2000, h: 1500 })
})

test('a 48–50 MP-sized original over 10 MB is shrunk and accepted', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'imports a source module from the Vite dev server')
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const mod = (await import(
      /* @vite-ignore */ `${location.origin}/src/features/import/preprocess.ts`
    )) as typeof import('../src/features/import/preprocess')
    // A real, decodable 4000×3000 JPEG, padded past 10 MB with trailing bytes
    // (decoders ignore data after the EOI marker), like a big phone photo.
    const canvas = document.createElement('canvas')
    canvas.width = 4000
    canvas.height = 3000
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 4000, 3000)
    ctx.fillStyle = '#123'
    ctx.fillRect(500, 500, 3000, 2000)
    const jpeg = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.9))
    const original = new File([jpeg, new Uint8Array(12 * 1024 * 1024)], 'IMG_50MP.jpg', {
      type: 'image/jpeg',
    })
    const prepared = await mod.preprocessImage(original)
    return {
      originalBytes: original.size,
      uploadBytes: prepared.blob.size,
      w: prepared.width,
      h: prepared.height,
      limit: mod.MAX_UPLOAD_BYTES,
    }
  })
  expect(result.originalBytes).toBeGreaterThan(result.limit)
  expect(result.uploadBytes).toBeLessThan(result.limit)
  expect(result).toMatchObject({ w: 2000, h: 1500 })
})

test('a tall portrait photo keeps its aspect ratio in the corner editor', async ({
  page,
}, testInfo) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'mocked recognition only')
  await page.goto('/login')
  // A 1500×4000 portrait "photo" with a grid drawn on it.
  const tall = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1500
    canvas.height = 4000
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#e8e2d0'
    ctx.fillRect(0, 0, 1500, 4000)
    ctx.strokeStyle = '#222'
    for (let k = 0; k <= 9; k++) {
      ctx.lineWidth = k % 3 === 0 ? 12 : 4
      const p = 150 + k * 133
      ctx.beginPath()
      ctx.moveTo(p, 1250)
      ctx.lineTo(p, 2450)
      ctx.moveTo(150, 1250 + k * 133)
      ctx.lineTo(1350, 1250 + k * 133)
      ctx.stroke()
    }
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.9))
    return [...new Uint8Array(await blob.arrayBuffer())]
  })
  await page.getByLabel('Email or username').fill('demo')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.getByRole('link', { name: 'Import from photo' }).click()
  await page.getByLabel('Photo file').setInputFiles({
    name: 'tall.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(tall),
  })
  await expect(page.getByRole('heading', { name: 'Check the puzzle' })).toBeVisible()

  const frame = page.locator('.photo-editor__frame')
  const img = page.locator('.photo-editor__img')
  await expect(img).toBeVisible()
  const viewport = page.viewportSize()!
  const box = (await frame.boundingBox())!
  // Preprocessed to 750×2000: the frame keeps that ratio and the 75vh height cap.
  expect(box.width / box.height).toBeCloseTo(750 / 2000, 2)
  expect(box.height).toBeLessThanOrEqual(viewport.height * 0.75 + 1)
  // Image, overlay and handles share the frame's coordinate box.
  for (const layer of [img, page.locator('.photo-editor__overlay')]) {
    const b = (await layer.boundingBox())!
    expect(Math.abs(b.x - box.x) + Math.abs(b.y - box.y)).toBeLessThan(1)
    expect(Math.abs(b.width - box.width) + Math.abs(b.height - box.height)).toBeLessThan(1)
  }
  const handle = page.getByRole('button', { name: /^Bottom-right corner/ })
  const [x, y] = /x (\d+), y (\d+)/
    .exec((await handle.getAttribute('aria-label'))!)!
    .slice(1)
    .map(Number)
  const h = (await handle.boundingBox())!
  expect(h.x + h.width / 2).toBeCloseTo(box.x + (x! / 750) * box.width, 0)
  expect(h.y + h.height / 2).toBeCloseTo(box.y + (y! / 2000) * box.height, 0)

  // Manual visual check: SHOTS_DIR=/tmp/sudoku-shots npx playwright test -g "tall portrait"
  if (process.env.SHOTS_DIR)
    await page.screenshot({
      path: `${process.env.SHOTS_DIR}/import-tall-${testInfo.project.name}.png`,
      fullPage: false,
    })
})
