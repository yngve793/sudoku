/**
 * Client-side photo preprocessing (PLAN.md §5.6): apply the EXIF orientation,
 * downscale to at most 2000 px on the long side and re-encode as JPEG. Drawing
 * onto a canvas and re-encoding drops every metadata block (EXIF, GPS, maker
 * notes), so location data never leaves the device.
 *
 * The math (`fitWithin`, `checkFile`) is pure and unit-tested; `preprocessImage`
 * needs a real browser (createImageBitmap + canvas) and is covered by e2e.
 */

/**
 * Decode-safety cap on the *original* file. The server's 10 MB limit applies to
 * the re-encoded upload (≤ 2000 px, usually ~1 MB), so 12–25 MB photos from
 * 48–50 MP phone modes are fine; this only stops absurd files before decoding.
 */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024
/** Server limit on the uploaded (re-encoded) image (`image_too_large`). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_LONG_SIDE = 2000
export const JPEG_QUALITY = 0.9

/** A problem with the chosen file, phrased for the player. */
export class PhotoInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhotoInputError'
  }
}

export interface Size {
  width: number
  height: number
}

/**
 * Size that fits within `maxSide` on the long side, keeping the aspect ratio.
 * Never upscales; never returns a side below 1 px.
 */
export function fitWithin(
  width: number,
  height: number,
  maxSide = MAX_LONG_SIDE,
): Size & { scale: number } {
  if (!(width > 0) || !(height > 0)) throw new RangeError('Image has no size')
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Rejects non-images, empty files and originals over the 50 MB decode cap
 * before any decoding. The 10 MB upload limit is checked after re-encoding.
 */
export function checkFile(file: Pick<File, 'type' | 'size' | 'name'>): PhotoInputError | null {
  const looksLikeImage =
    file.type.startsWith('image/') ||
    (file.type === '' && /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(file.name))
  if (!looksLikeImage)
    return new PhotoInputError(
      `"${file.name || 'This file'}" is not an image. Choose a photo (JPEG, PNG or WebP).`,
    )
  if (file.size === 0) return new PhotoInputError('This file is empty. Choose another photo.')
  if (file.size > MAX_SOURCE_BYTES)
    return new PhotoInputError(
      `This file is ${formatMb(file.size)}, too big to open here (the limit is 50 MB). Try a smaller photo or a screenshot of it.`,
    )
  return null
}

export interface PreparedPhoto {
  /** Re-encoded JPEG without metadata; this is what gets uploaded. */
  blob: Blob
  /** Size of the oriented, downscaled image (the coordinate space of `corners`). */
  width: number
  height: number
}

interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      }
    } catch {
      // Fall through to <img>, which also honours EXIF orientation in current browsers.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch {
    URL.revokeObjectURL(url)
    throw new PhotoInputError(
      "We couldn't read this image. Try a JPEG or PNG photo (some phones save HEIC, which browsers can't always open).",
    )
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new PhotoInputError('Could not prepare the photo for upload.')),
      'image/jpeg',
      quality,
    )
  })
}

/** Orients, downscales and re-encodes `file` (strips EXIF/GPS). Browser only. */
export async function preprocessImage(file: File): Promise<PreparedPhoto> {
  const problem = checkFile(file)
  if (problem) throw problem
  const decoded = await decode(file)
  try {
    const { width, height } = fitWithin(decoded.width, decoded.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new PhotoInputError('Your browser could not prepare the photo for upload.')
    // JPEG has no alpha: flatten transparent PNGs onto white, not black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(decoded.source, 0, 0, width, height)
    const blob = await toJpeg(canvas, JPEG_QUALITY)
    if (blob.size > MAX_UPLOAD_BYTES)
      throw new PhotoInputError(
        `Even after shrinking, this photo is ${formatMb(blob.size)}; the upload limit is 10 MB. Try a smaller or less detailed photo.`,
      )
    return { blob, width, height }
  } finally {
    decoded.close()
  }
}
