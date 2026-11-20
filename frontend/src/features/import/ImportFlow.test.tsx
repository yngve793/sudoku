import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { delay, http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../mocks/db'
import { MISREAD_CELL, simulateImportError } from '../../mocks/imports'
import { server } from '../../mocks/node'
import { fakePhotoFile } from '../../test/images'
import { cellLabelPrefix, loginAsDemo, renderApp, seedGame } from '../../test/utils'
import { importTimings } from './importSession'

// jsdom has no canvas/createImageBitmap: pass the (fake JPEG) file through
// unchanged, but keep the real size/type checks.
vi.mock('./preprocess', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./preprocess')>()
  return {
    ...mod,
    preprocessImage: vi.fn((file: File) => {
      const problem = mod.checkFile(file)
      if (problem) return Promise.reject(problem)
      return Promise.resolve({ blob: file, width: 1200, height: 900 })
    }),
  }
})

const original = { ...importTimings }
const createObjectURL = URL.createObjectURL.bind(URL) as typeof URL.createObjectURL | undefined
beforeAll(() => {
  importTimings.checkDebounceMs = 0
  importTimings.checkRetryMs = 0
  URL.createObjectURL = () => 'blob:mock-photo'
  URL.revokeObjectURL = () => undefined
})
afterAll(() => {
  Object.assign(importTimings, original)
  if (createObjectURL) URL.createObjectURL = createObjectURL
})
beforeEach(async () => {
  await loginAsDemo()
})
afterEach(() => {
  for (const endpoint of ['recognize', 'check', 'import'] as const)
    simulateImportError(endpoint, null)
})

async function uploadPhoto(file = fakePhotoFile()) {
  const app = renderApp('/import')
  await app.user.upload(await screen.findByLabelText('Photo file'), file)
  await screen.findByRole('heading', { name: 'Check the puzzle' })
  return app
}

const grid = () => screen.getByRole('grid', { name: 'Recognised puzzle' })
const cell = (index: number) =>
  within(grid()).getByRole('gridcell', { name: new RegExp(`^${cellLabelPrefix(index)}`) })
const checkStatus = () => document.querySelector<HTMLElement>('.check-status')!
const startButton = () => screen.getByRole('button', { name: 'Start game' })

describe('photo import: upload', () => {
  it('uploads a photo and opens the review screen', async () => {
    await uploadPhoto()
    expect(within(grid()).getAllByRole('gridcell')).toHaveLength(81)
    expect(screen.getByRole('img', { name: 'The Sudoku you uploaded' })).toHaveAttribute(
      'src',
      'blob:mock-photo',
    )
    for (const name of ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'])
      expect(screen.getByRole('button', { name: new RegExp(`^${name} corner`) })).toBeEnabled()
    expect(screen.getByText('A handwritten digit contradicts a printed given.')).toBeVisible()
  })

  it('rejects non-images and originals over the 50 MB decode cap before uploading', async () => {
    const recognize = vi.fn()
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/imports/recognize')) recognize()
    })
    renderApp('/import')
    const input = await screen.findByLabelText('Photo file')
    fireEvent.change(input, {
      target: { files: [new File(['%PDF'], 'puzzle.pdf', { type: 'application/pdf' })] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('"puzzle.pdf" is not an image')
    const huge = new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'big.jpg', {
      type: 'image/jpeg',
    })
    fireEvent.change(input, { target: { files: [huge] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('the limit is 50 MB')
    expect(recognize).not.toHaveBeenCalled()
    server.events.removeAllListeners()
  })

  it.each([
    [413, 'image_too_large', /too large for the server/],
    [415, 'unsupported_image', /Use a JPEG, PNG or WebP photo/],
    [422, 'no_grid_found', /couldn't find a Sudoku grid in this photo/],
    [422, 'image_unreadable', /couldn't read this image/],
    [429, 'rate_limited', /a lot of photos in a short time/],
    [503, 'recognition_unavailable', /busy or unavailable/],
  ])('maps %i %s to a clear message', async (status, code, text) => {
    simulateImportError('recognize', { status, code })
    const { user } = renderApp('/import')
    await user.upload(await screen.findByLabelText('Photo file'), fakePhotoFile())
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    // Still on the upload screen, ready for another try.
    expect(screen.getByRole('button', { name: 'Choose photo' })).toBeEnabled()
  })

  it('accepts a dropped or pasted image', async () => {
    renderApp('/import')
    await screen.findByText('Drop a photo here')
    const paste = new Event('paste', { bubbles: true }) as Event & {
      clipboardData: { files: File[] }
    }
    paste.clipboardData = { files: [fakePhotoFile('pasted.png')] }
    document.dispatchEvent(paste)
    expect(await screen.findByRole('heading', { name: 'Check the puzzle' })).toBeInTheDocument()
  })

  it('shows progress and can cancel the upload', async () => {
    server.use(
      http.post('*/api/v1/imports/recognize', async () => {
        await delay('infinite')
        return HttpResponse.json({})
      }),
    )
    const { user } = renderApp('/import')
    const drop = (await screen.findByText('Drop a photo here')).parentElement!
    fireEvent.drop(drop, { dataTransfer: { files: [fakePhotoFile()] } })
    expect(await screen.findByRole('progressbar', { name: 'Upload progress' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Upload cancelled.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose photo' })).toBeEnabled()
  })

  it('sends logged-out users to the login page and /import/review without a photo back', async () => {
    const { router } = renderApp('/import/review')
    await waitFor(() => expect(router.state.location.pathname).toBe('/import'))
    expect(await screen.findByRole('heading', { name: 'Import from photo' })).toBeInTheDocument()
  })
})

describe('photo import: review', () => {
  it('marks low-confidence, auto-corrected and contradicting cells; a handwritten conflict only warns', async () => {
    await uploadPhoto()
    await waitFor(() =>
      expect(cell(MISREAD_CELL)).toHaveAccessibleName(
        `${cellLabelPrefix(MISREAD_CELL)} 9, handwritten, low confidence, please check, contradiction`,
      ),
    )
    expect(cell(4)).toHaveAccessibleName(
      `${cellLabelPrefix(4)} 7, given, auto-corrected, please check`,
    )
    expect(cell(0)).toHaveAccessibleName(
      `${cellLabelPrefix(0)} 5, given, low confidence, please check`,
    )
    expect(within(checkStatus()).getByText(/9 appears twice in box 1/)).toBeInTheDocument()
    expect(screen.getByText('Unique solution')).toBeInTheDocument()
    // Only a handwritten entry conflicts: the givens are valid, so Start is allowed.
    await waitFor(() => expect(startButton()).toBeEnabled())
    expect(
      screen.getByText(
        'Your handwritten entries contain a conflict. You can fix it now or after starting.',
      ),
    ).toBeVisible()
  })

  it('starts with a handwritten conflict; the board shows it as a conflict', async () => {
    const { user, router } = await uploadPhoto()
    await waitFor(() => expect(startButton()).toBeEnabled())
    await user.click(startButton())
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/game\/\d+$/))
    const board = await screen.findByRole('grid', { name: 'Sudoku board' })
    expect(db.games.at(-1)!.current[MISREAD_CELL]).toBe('9')
    expect(
      within(board).getByRole('gridcell', {
        name: `${cellLabelPrefix(MISREAD_CELL)} 9, conflict`,
      }),
    ).toBeInTheDocument()
  })

  it('blocks Start when the givens themselves conflict', async () => {
    const { user } = await uploadPhoto()
    await user.click(cell(MISREAD_CELL))
    await user.keyboard('4')
    await waitFor(() => expect(startButton()).toBeEnabled())
    // r1c2 is a printed 3; make it a 5, clashing with the printed 5 at r1c1.
    await user.click(cell(1))
    await user.keyboard('5')
    expect(
      await within(checkStatus()).findByText(/The printed digits have no solution/),
    ).toBeInTheDocument()
    expect(startButton()).toBeDisabled()
    expect(startButton()).toHaveAccessibleDescription('Fix the problems above to start.')
    expect(screen.queryByText(/handwritten entries contain a conflict/)).not.toBeInTheDocument()
  })

  it('fixes a misread cell from its alternatives, then starts the imported game', async () => {
    const { user, router } = await uploadPhoto()
    await user.click(cell(MISREAD_CELL))
    const alternatives = screen.getByRole('group', { name: 'Alternatives' })
    await user.click(within(alternatives).getByRole('button', { name: 'Use 4 (38%)' }))
    await waitFor(() =>
      expect(cell(MISREAD_CELL)).toHaveAccessibleName(
        `${cellLabelPrefix(MISREAD_CELL)} 4, handwritten`,
      ),
    )
    await waitFor(() => expect(startButton()).toBeEnabled())
    expect(screen.getByText('No conflicts')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()

    await user.click(startButton())
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/game\/\d+$/))
    const board = await screen.findByRole('grid', { name: 'Sudoku board' })
    expect(screen.getByText('Imported')).toBeInTheDocument()
    const game = db.games.at(-1)!
    expect(game.source).toBe('imported')
    expect(game.current[MISREAD_CELL]).toBe('4')
    // Handwritten entries are the player's (editable), givens are fixed.
    expect(
      within(board).getByRole('gridcell', { name: `${cellLabelPrefix(MISREAD_CELL)} 4` }),
    ).toBeInTheDocument()
    expect(
      within(board).getByRole('gridcell', { name: `${cellLabelPrefix(0)} 5, given` }),
    ).toBeInTheDocument()
  })

  it('edits with the keyboard: digits, Backspace, arrows and T for the kind', async () => {
    const { user } = await uploadPhoto()
    await user.click(cell(0))
    await user.keyboard('t')
    expect(cell(0)).toHaveAccessibleName(/^Row 1, column 1, 5, handwritten/)
    expect(screen.getByText(/29 givens · 7 handwritten/)).toBeInTheDocument()
    await user.keyboard('T')
    expect(cell(0)).toHaveAccessibleName(/^Row 1, column 1, 5, given/)
    await user.keyboard('{ArrowRight}{ArrowRight}4')
    expect(cell(2)).toHaveFocus()
    await waitFor(() =>
      expect(cell(2)).toHaveAccessibleName(`${cellLabelPrefix(2)} 4, handwritten`),
    )
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(cell(23)).toHaveFocus()
    await user.keyboard('6')
    expect(cell(23)).toHaveAccessibleName(`${cellLabelPrefix(23)} 6, given`)
    await user.keyboard('{Backspace}')
    expect(cell(23)).toHaveAccessibleName(`${cellLabelPrefix(23)} empty`)
    // Enter accepts a flagged reading as it is.
    await user.click(cell(4))
    await user.keyboard('{Enter}')
    expect(cell(4)).toHaveAccessibleName(`${cellLabelPrefix(4)} 7, given`)
    await waitFor(() => expect(startButton()).toBeEnabled())
  })

  it('switches between all digits and only givens', async () => {
    const { user } = await uploadPhoto()
    await user.click(screen.getByRole('radio', { name: 'Only givens' }))
    expect(cell(3)).toHaveAccessibleName(`${cellLabelPrefix(3)} empty`)
    expect(cell(0)).toHaveAccessibleName(/5, given/)
    await user.click(screen.getByRole('radio', { name: 'Givens + handwritten' }))
    expect(cell(3)).toHaveAccessibleName(`${cellLabelPrefix(3)} 6, handwritten`)
  })

  it('reports multiple solutions when a given is marked handwritten', async () => {
    const { user } = await uploadPhoto()
    await user.click(cell(MISREAD_CELL))
    await user.keyboard('4')
    // Turn many givens into handwritten entries: the givens alone are no longer unique.
    for (const index of [0, 1, 4, 9, 12, 13, 14]) {
      await user.click(cell(index))
      await user.keyboard('t')
    }
    expect(
      await within(checkStatus()).findByText(/The printed digits have more than one solution/),
    ).toBeInTheDocument()
    expect(startButton()).toBeDisabled()
  })

  it('handles a 429 from the live check without enabling Start', async () => {
    simulateImportError('check', { status: 429, code: 'rate_limited' })
    await uploadPhoto()
    expect(await screen.findByText(/validation is paused/)).toBeInTheDocument()
    expect(startButton()).toBeDisabled()
    simulateImportError('check', null)
    await waitFor(() => expect(screen.queryByText(/validation is paused/)).not.toBeInTheDocument())
    expect(screen.getByText('Unique solution')).toBeInTheDocument()
  })

  it.each([
    ['multiple_solutions', /more than one solution/],
    ['no_solution', /have no solution/],
    ['puzzle_inconsistent', /contradict each other/],
    ['givens_modified', /overwrites a printed given/],
  ])('explains a 422 %s from Start game', async (code, text) => {
    const { user } = await uploadPhoto()
    await user.click(cell(MISREAD_CELL))
    await user.keyboard('4')
    await waitFor(() => expect(startButton()).toBeEnabled())
    simulateImportError('import', { status: 422, code })
    await user.click(startButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('keeps the review and re-enables Start after a 429 from Start game', async () => {
    const { user } = await uploadPhoto()
    await user.click(cell(MISREAD_CELL))
    await user.keyboard('4')
    await waitFor(() => expect(startButton()).toBeEnabled())
    simulateImportError('import', { status: 429, code: 'rate_limited' })
    await user.click(startButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /started several games from photos.*corrections are kept/,
    )
    // Still on the review screen with the correction intact; Start is retryable.
    expect(cell(MISREAD_CELL)).toHaveAccessibleName(
      `${cellLabelPrefix(MISREAD_CELL)} 4, handwritten`,
    )
    expect(startButton()).toBeEnabled()
    simulateImportError('import', null)
    await user.click(startButton())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Start game' })).not.toBeInTheDocument(),
    )
  })

  it('warns that starting abandons the current game', async () => {
    seedGame()
    await uploadPhoto()
    expect(await screen.findByText('Starting abandons your current Easy game.')).toBeInTheDocument()
  })

  it('nudges a corner with the keyboard and re-detects with those corners', async () => {
    const sent: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/imports/recognize'))
        void request
          .clone()
          .formData()
          .then((f) => sent.push(f.get('corners') as string))
    })
    const { user } = await uploadPhoto()
    const redetect = screen.getByRole('button', { name: 'Re-detect' })
    expect(redetect).toBeDisabled()
    const handle = screen.getByRole('button', { name: /^Top-left corner/ })
    const before = handle.getAttribute('aria-label')!
    handle.focus()
    await user.keyboard('{ArrowRight}{Shift>}{ArrowDown}{/Shift}')
    // 1200×900 photo: 6 px per arrow, 60 px with Shift.
    expect(handle.getAttribute('aria-label')).not.toBe(before)
    const [, x, y] = /x (\d+), y (\d+)/.exec(handle.getAttribute('aria-label')!)!.map(Number)
    const [, x0, y0] = /x (\d+), y (\d+)/.exec(before)!.map(Number)
    expect([x! - x0!, y! - y0!]).toEqual([6, 60])

    await user.click(cell(10))
    await user.keyboard('9')
    await user.click(redetect)
    await waitFor(() => expect(sent).toHaveLength(2))
    expect((JSON.parse(sent[1]!) as number[][])[0]).toEqual([
      expect.closeTo(x!, 0),
      expect.closeTo(y!, 0),
    ])
    // The fresh recognition replaced the manual edit.
    await waitFor(() =>
      expect(cell(10)).toHaveAccessibleName(`${cellLabelPrefix(10)} 7, handwritten`),
    )
    expect(screen.getByRole('button', { name: 'Re-detect' })).toBeDisabled()
    server.events.removeAllListeners()
  })

  it('explains a failed re-detect in terms of the corners', async () => {
    const { user } = await uploadPhoto()
    screen.getByRole('button', { name: /^Bottom-right corner/ }).focus()
    await user.keyboard('{ArrowLeft}')
    simulateImportError('recognize', { status: 422, code: 'no_grid_found' })
    await user.click(screen.getByRole('button', { name: 'Re-detect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/inside those corners/)
  })
})
