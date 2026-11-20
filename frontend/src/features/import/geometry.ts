/**
 * Coordinate mapping for the corner editor. Corners live in pixels of the
 * oriented image that was uploaded (`RecognitionOut.image_size`); the photo is
 * displayed scaled to an arbitrary on-screen box with the same aspect ratio.
 */
import type { Corner, ImageSize } from '../../api/types'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Rounds to 0.1 px so repeated nudges don't accumulate float noise. */
const tidy = (v: number) => Math.round(v * 10) / 10

/** Keeps a point inside the image. */
export function clampToImage([x, y]: Corner, size: ImageSize): Corner {
  return [tidy(clamp(x, 0, size.width)), tidy(clamp(y, 0, size.height))]
}

/**
 * Pointer position (client/viewport px) → image px, given the displayed photo's
 * bounding rect. Clamped to the image.
 */
export function clientToImage(
  clientX: number,
  clientY: number,
  rect: Rect,
  size: ImageSize,
): Corner {
  if (rect.width <= 0 || rect.height <= 0) return [0, 0]
  const x = ((clientX - rect.left) / rect.width) * size.width
  const y = ((clientY - rect.top) / rect.height) * size.height
  return clampToImage([x, y], size)
}

/** The photo in the corner editor never takes more than this share of the viewport height. */
export const PHOTO_MAX_VH = 75

/**
 * Inline sizing for the corner editor's frame. The frame must keep the image's
 * exact aspect ratio, because the image (`object-fit: fill`), the SVG overlay
 * and the handles all map image px onto that one box. A `max-height` would
 * override `aspect-ratio` and squash tall photos, so the height cap is
 * expressed as a width cap instead: width = min(100%, 75vh × width/height).
 */
export function photoFrameStyle(size: ImageSize): { aspectRatio: string; width: string } {
  const ratio = size.width > 0 && size.height > 0 ? size.width / size.height : 1
  const maxWidthVh = Math.round(PHOTO_MAX_VH * ratio * 1000) / 1000
  return {
    aspectRatio: `${size.width} / ${size.height}`,
    width: `min(100%, ${maxWidthVh}vh)`,
  }
}

/** Image px → position within the displayed box, as CSS percentages. */
export function imageToPercent([x, y]: Corner, size: ImageSize): { left: number; top: number } {
  return { left: (x / size.width) * 100, top: (y / size.height) * 100 }
}

/** Arrow-key step in image px: ~0.5 % of the long side (5 % with Shift), at least 1 px. */
export function nudgeStep(size: ImageSize, large: boolean): number {
  const long = Math.max(size.width, size.height)
  return Math.max(1, Math.round(long * (large ? 0.05 : 0.005)))
}

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

export function nudge(point: Corner, key: ArrowKey, step: number, size: ImageSize): Corner {
  const [x, y] = point
  const delta: Record<ArrowKey, Corner> = {
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
  }
  const [dx, dy] = delta[key]
  return clampToImage([x + dx, y + dy], size)
}

/** True if TL, TR, BR, BL form a convex quadrilateral in that winding order. */
export function isConvexQuad(corners: readonly Corner[]): boolean {
  if (corners.length !== 4) return false
  const at = (k: number): Corner => corners[k % 4] ?? [0, 0]
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = at(i)
    const [bx, by] = at(i + 1)
    const [cx, cy] = at(i + 2)
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
    if (cross === 0) return false
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** SVG `points` attribute for the outline, in image px (use with a matching viewBox). */
export function polygonPoints(corners: readonly Corner[]): string {
  return corners.map(([x, y]) => `${x},${y}`).join(' ')
}

/** Rescales corners between two sizes of the same image (e.g. server vs. displayed). */
export function scaleCorners(corners: readonly Corner[], from: ImageSize, to: ImageSize): Corner[] {
  const sx = to.width / from.width
  const sy = to.height / from.height
  return corners.map(([x, y]) => [tidy(x * sx), tidy(y * sy)] as Corner)
}
