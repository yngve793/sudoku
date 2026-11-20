import { describe, expect, it } from 'vitest'
import type { Corner } from '../../api/types'
import {
  clampToImage,
  clientToImage,
  imageToPercent,
  isConvexQuad,
  nudge,
  nudgeStep,
  photoFrameStyle,
  PHOTO_MAX_VH,
  polygonPoints,
  scaleCorners,
} from './geometry'

const size = { width: 2000, height: 1500 }

describe('clientToImage', () => {
  it('maps the displayed box linearly onto image pixels', () => {
    // Photo shown at 400×300 starting at (100, 50) in the viewport: scale 5.
    const rect = { left: 100, top: 50, width: 400, height: 300 }
    expect(clientToImage(100, 50, rect, size)).toEqual([0, 0])
    expect(clientToImage(500, 350, rect, size)).toEqual([2000, 1500])
    expect(clientToImage(300, 200, rect, size)).toEqual([1000, 750])
    expect(clientToImage(101.3, 50.7, rect, size)).toEqual([6.5, 3.5])
  })

  it('clamps pointers dragged outside the photo', () => {
    const rect = { left: 0, top: 0, width: 200, height: 150 }
    expect(clientToImage(-40, 500, rect, size)).toEqual([0, 1500])
    expect(clientToImage(9999, -1, rect, size)).toEqual([2000, 0])
  })

  it('is the inverse of imageToPercent', () => {
    const rect = { left: 10, top: 20, width: 640, height: 480 }
    const p: Corner = [1234, 567]
    const pct = imageToPercent(p, size)
    const client = [
      rect.left + (pct.left / 100) * rect.width,
      rect.top + (pct.top / 100) * rect.height,
    ] as const
    const [x, y] = clientToImage(client[0], client[1], rect, size)
    expect(x).toBeCloseTo(1234, 0)
    expect(y).toBeCloseTo(567, 0)
  })

  it('returns the origin for a collapsed rect instead of dividing by zero', () => {
    expect(clientToImage(5, 5, { left: 0, top: 0, width: 0, height: 0 }, size)).toEqual([0, 0])
  })
})

describe('keyboard nudging', () => {
  it('steps about 0.5 % of the long side, 5 % with Shift, at least 1 px', () => {
    expect(nudgeStep(size, false)).toBe(10)
    expect(nudgeStep(size, true)).toBe(100)
    expect(nudgeStep({ width: 50, height: 40 }, false)).toBe(1)
  })

  it('moves in the arrow direction and stays inside the image', () => {
    expect(nudge([100, 100], 'ArrowRight', 10, size)).toEqual([110, 100])
    expect(nudge([100, 100], 'ArrowLeft', 10, size)).toEqual([90, 100])
    expect(nudge([100, 100], 'ArrowUp', 10, size)).toEqual([100, 90])
    expect(nudge([100, 100], 'ArrowDown', 10, size)).toEqual([100, 110])
    expect(nudge([5, 1495], 'ArrowLeft', 10, size)).toEqual([0, 1495])
    expect(nudge([5, 1495], 'ArrowDown', 10, size)).toEqual([5, 1500])
  })

  it('clampToImage rounds to 0.1 px', () => {
    expect(clampToImage([10.04, 20.06], size)).toEqual([10, 20.1])
  })
})

describe('isConvexQuad', () => {
  it('accepts TL, TR, BR, BL outlines, including perspective', () => {
    expect(
      isConvexQuad([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    ).toBe(true)
    expect(
      isConvexQuad([
        [100, 80],
        [900, 120],
        [950, 900],
        [60, 860],
      ]),
    ).toBe(true)
  })

  it('rejects crossed, collapsed or incomplete outlines', () => {
    // TR and BR swapped: a bow tie.
    expect(
      isConvexQuad([
        [0, 0],
        [10, 10],
        [10, 0],
        [0, 10],
      ]),
    ).toBe(false)
    expect(
      isConvexQuad([
        [0, 0],
        [5, 0],
        [10, 0],
        [0, 10],
      ]),
    ).toBe(false)
    expect(
      isConvexQuad([
        [0, 0],
        [10, 0],
        [10, 10],
      ]),
    ).toBe(false)
  })
})

describe('helpers', () => {
  it('polygonPoints formats an SVG points list', () => {
    expect(
      polygonPoints([
        [1, 2],
        [3.5, 4],
        [5, 6],
        [7, 8],
      ]),
    ).toBe('1,2 3.5,4 5,6 7,8')
  })

  it('scaleCorners maps between two sizes of the same image', () => {
    expect(
      scaleCorners(
        [
          [100, 50],
          [1900, 60],
          [1950, 1400],
          [80, 1450],
        ],
        size,
        {
          width: 1000,
          height: 750,
        },
      ),
    ).toEqual([
      [50, 25],
      [950, 30],
      [975, 700],
      [40, 725],
    ])
  })
})

describe('photoFrameStyle', () => {
  it('caps the height at 75vh through the width, keeping the exact aspect ratio', () => {
    expect(PHOTO_MAX_VH).toBe(75)
    // Tall portrait (1500×4000 → 750×2000 after preprocessing): 75vh × 0.375.
    expect(photoFrameStyle({ width: 750, height: 2000 })).toEqual({
      aspectRatio: '750 / 2000',
      width: 'min(100%, 28.125vh)',
    })
    // Landscape: the width cap is above 100% on any sane screen, so full width.
    expect(photoFrameStyle({ width: 1200, height: 900 })).toEqual({
      aspectRatio: '1200 / 900',
      width: 'min(100%, 100vh)',
    })
    expect(photoFrameStyle({ width: 1000, height: 1000 }).width).toBe('min(100%, 75vh)')
  })

  it('rounds the cap and survives a degenerate size', () => {
    expect(photoFrameStyle({ width: 1000, height: 3000 }).width).toBe('min(100%, 25vh)')
    expect(photoFrameStyle({ width: 1, height: 3 }).width).toBe('min(100%, 25vh)')
    expect(photoFrameStyle({ width: 2, height: 3 }).width).toBe('min(100%, 50vh)')
    expect(photoFrameStyle({ width: 1, height: 7 }).width).toBe('min(100%, 10.714vh)')
    expect(photoFrameStyle({ width: 0, height: 0 }).width).toBe('min(100%, 75vh)')
  })
})
