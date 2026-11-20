import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import type { Corner, ImageSize } from '../../api/types'
import {
  CORNER_NAMES,
  clientToImage,
  imageToPercent,
  isConvexQuad,
  nudge,
  nudgeStep,
  photoFrameStyle,
  polygonPoints,
  type ArrowKey,
} from './geometry'

interface CornerEditorProps {
  photoUrl: string
  /** Coordinate space of `corners` (the uploaded, oriented image). */
  size: ImageSize
  corners: readonly Corner[]
  onChange: (corners: Corner[]) => void
  disabled?: boolean
}

const ARROWS = new Set<string>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
const LABELS = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'] as const

/** Bilinear point on the quad (u along the top edge, v down the left edge). */
function lerpQuad(c: readonly Corner[], u: number, v: number): Corner {
  const [tl, tr, br, bl] = c as [Corner, Corner, Corner, Corner]
  const top: Corner = [tl[0] + (tr[0] - tl[0]) * u, tl[1] + (tr[1] - tl[1]) * u]
  const bottom: Corner = [bl[0] + (br[0] - bl[0]) * u, bl[1] + (br[1] - bl[1]) * u]
  return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v]
}

/** The photo with the detected grid outline and four draggable, keyboard-nudgeable corners. */
export function CornerEditor({ photoUrl, size, corners, onChange, disabled }: CornerEditorProps) {
  const frame = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)

  function move(index: number, point: Corner) {
    const next = corners.map((c) => [c[0], c[1]] as Corner)
    next[index] = point
    onChange(next)
  }

  function onPointerDown(index: number, event: PointerEvent<HTMLButtonElement>) {
    if (disabled) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = index
  }

  function onPointerMove(index: number, event: PointerEvent<HTMLButtonElement>) {
    if (dragging.current !== index || !frame.current) return
    const rect = frame.current.getBoundingClientRect()
    move(index, clientToImage(event.clientX, event.clientY, rect, size))
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    dragging.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || !ARROWS.has(event.key)) return
    event.preventDefault()
    const corner = corners[index]
    if (!corner) return
    move(index, nudge(corner, event.key as ArrowKey, nudgeStep(size, event.shiftKey), size))
  }

  const convex = isConvexQuad(corners)
  const gridLines: [Corner, Corner][] = []
  if (corners.length === 4)
    for (let k = 1; k < 9; k++) {
      const t = k / 9
      gridLines.push([lerpQuad(corners, t, 0), lerpQuad(corners, t, 1)])
      gridLines.push([lerpQuad(corners, 0, t), lerpQuad(corners, 1, t)])
    }

  return (
    <figure className="photo-editor">
      <div ref={frame} className="photo-editor__frame" style={photoFrameStyle(size)}>
        <img className="photo-editor__img" src={photoUrl} alt="The Sudoku you uploaded" />
        <svg
          className="photo-editor__overlay"
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {gridLines.map(([a, b], i) => (
            <line
              key={i}
              className="photo-editor__gridline"
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polygon
            className={`photo-editor__outline${convex ? '' : ' photo-editor__outline--bad'}`}
            points={polygonPoints(corners)}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {corners.map((corner, i) => {
          const pos = imageToPercent(corner, size)
          return (
            <button
              key={CORNER_NAMES[i]}
              type="button"
              className={`corner-handle corner-handle--${CORNER_NAMES[i]}`}
              style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
              aria-label={`${LABELS[i]} corner of the grid, at x ${Math.round(corner[0])}, y ${Math.round(corner[1])}. Drag, or use the arrow keys to move it (Shift for bigger steps).`}
              disabled={disabled}
              onPointerDown={(e) => onPointerDown(i, e)}
              onPointerMove={(e) => onPointerMove(i, e)}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={(e) => onKeyDown(i, e)}
            >
              <span className="corner-handle__label" aria-hidden="true">
                {['TL', 'TR', 'BR', 'BL'][i]}
              </span>
            </button>
          )
        })}
      </div>
      <figcaption className="photo-editor__caption">
        {convex
          ? 'The outline shows where we found the grid. If it is off, move the corner handles onto the outer corners of the grid and re-detect.'
          : 'The corners cross over each other. Put each handle on its own corner of the grid (top-left, top-right, bottom-right, bottom-left).'}
      </figcaption>
    </figure>
  )
}
