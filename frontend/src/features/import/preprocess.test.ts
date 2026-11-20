import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_LONG_SIDE,
  MAX_SOURCE_BYTES,
  MAX_UPLOAD_BYTES,
  PhotoInputError,
  checkFile,
  fitWithin,
  preprocessImage,
} from './preprocess'

const MB = 1024 * 1024

describe('fitWithin', () => {
  it('downscales the long side to 2000 px and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2000, height: 1500, scale: 2000 / 4032 })
    // Portrait (already EXIF-oriented): the height is the long side.
    expect(fitWithin(3024, 4032)).toMatchObject({ width: 1500, height: 2000 })
    expect(fitWithin(8000, 1000)).toMatchObject({ width: 2000, height: 250 })
  })

  it('never upscales small photos', () => {
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900, scale: 1 })
    expect(fitWithin(MAX_LONG_SIDE, 10)).toMatchObject({ width: MAX_LONG_SIDE, height: 10 })
  })

  it('rounds and never returns a zero side', () => {
    expect(fitWithin(4001, 3)).toMatchObject({ width: 2000, height: 1 })
    expect(fitWithin(3001, 1001)).toMatchObject({ width: 2000, height: 667 })
  })

  it('honours a custom limit and rejects empty sizes', () => {
    expect(fitWithin(1000, 500, 100)).toMatchObject({ width: 100, height: 50 })
    expect(() => fitWithin(0, 100)).toThrow(RangeError)
  })
})

describe('checkFile', () => {
  const file = (type: string, size: number, name = 'p.jpg') => ({ type, size, name })

  it('accepts images up to the 50 MB decode cap, including 12–25 MB phone photos', () => {
    expect(checkFile(file('image/jpeg', 3_000_000))).toBeNull()
    // 48–50 MP phone modes: well over the 10 MB upload limit before shrinking.
    expect(checkFile(file('image/jpeg', 12 * MB))).toBeNull()
    expect(checkFile(file('image/jpeg', 25 * MB))).toBeNull()
    expect(checkFile(file('image/heic', MAX_SOURCE_BYTES, 'IMG.HEIC'))).toBeNull()
    // Some pickers leave `type` empty; fall back to the extension.
    expect(checkFile(file('', 1000, 'scan.PNG'))).toBeNull()
  })

  it('rejects non-images with a friendly message', () => {
    const error = checkFile(file('application/pdf', 1000, 'puzzle.pdf'))
    expect(error).toBeInstanceOf(PhotoInputError)
    expect(error?.message).toMatch(/"puzzle\.pdf" is not an image/)
    expect(checkFile(file('', 1000, 'notes.txt'))?.message).toMatch(/not an image/)
  })

  it('rejects originals over the 50 MB decode cap and empty files', () => {
    expect(MAX_SOURCE_BYTES).toBe(50 * MB)
    expect(checkFile(file('image/jpeg', MAX_SOURCE_BYTES + 1))?.message).toMatch(
      /50\.0 MB, too big to open here \(the limit is 50 MB\)/,
    )
    expect(checkFile(file('image/jpeg', 0))?.message).toMatch(/empty/)
  })
})

/**
 * jsdom has no canvas or createImageBitmap, so these stub both: a decoded
 * bitmap of the given size and a canvas whose JPEG has `encodedBytes` bytes.
 * The real pipeline is covered by the e2e (`e2e/import.spec.ts`).
 */
describe('preprocessImage size limits', () => {
  function stubBrowser(decoded: { width: number; height: number }, encodedBytes: number) {
    const close = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ ...decoded, close })),
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb, type) =>
      cb(new Blob([new Uint8Array(encodedBytes)], { type })),
    )
    return { close, drawImage }
  }
  const bigFile = (bytes: number) =>
    new File([new Uint8Array(bytes)], 'IMG_50MP.jpg', { type: 'image/jpeg' })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('accepts a 25 MB, 50 MP original that shrinks below the 10 MB upload limit', async () => {
    const { close, drawImage } = stubBrowser({ width: 8160, height: 6120 }, 1.2 * MB)
    const prepared = await preprocessImage(bigFile(25 * MB))
    expect(prepared).toMatchObject({ width: 2000, height: 1500 })
    expect(prepared.blob.type).toBe('image/jpeg')
    expect(prepared.blob.size).toBeLessThan(MAX_UPLOAD_BYTES)
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2000, 1500)
    expect(close).toHaveBeenCalled()
  })

  it('still rejects a re-encoded image over 10 MB', async () => {
    const { close } = stubBrowser({ width: 2000, height: 2000 }, MAX_UPLOAD_BYTES + 1)
    await expect(preprocessImage(bigFile(12 * MB))).rejects.toThrow(
      /Even after shrinking, this photo is 10\.0 MB; the upload limit is 10 MB/,
    )
    expect(close).toHaveBeenCalled()
  })

  it('accepts a re-encoded image of exactly 10 MB', async () => {
    stubBrowser({ width: 2000, height: 2000 }, MAX_UPLOAD_BYTES)
    await expect(preprocessImage(bigFile(12 * MB))).resolves.toMatchObject({ width: 2000 })
  })

  it('rejects an original over the decode cap without decoding it', async () => {
    stubBrowser({ width: 8160, height: 6120 }, MB)
    await expect(preprocessImage(bigFile(MAX_SOURCE_BYTES + 1))).rejects.toBeInstanceOf(
      PhotoInputError,
    )
    expect(createImageBitmap).not.toHaveBeenCalled()
  })
})
