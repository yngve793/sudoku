import type { Direction } from './gameReducer'

export type KeyCommand =
  | { type: 'move'; direction: Direction }
  | { type: 'input'; digit: number }
  | { type: 'note'; digit: number }
  | { type: 'erase' }
  | { type: 'toggleNotes' }
  | { type: 'hint' }
  | { type: 'undo' }
  | { type: 'redo' }

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

interface KeyLike {
  key: string
  code: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** Pure key → command mapping for the board (unit-tested). */
export function keyToCommand(event: KeyLike): KeyCommand | null {
  const mod = event.ctrlKey || event.metaKey
  if (event.altKey) return null
  const lower = event.key.toLowerCase()

  if (mod) {
    if (lower === 'z') return event.shiftKey ? { type: 'redo' } : { type: 'undo' }
    if (lower === 'y') return { type: 'redo' }
    return null
  }

  const arrow = ARROWS[event.key]
  if (arrow) return { type: 'move', direction: arrow }

  // Use `code` so Shift+digit works on every layout (Shift+1 gives "!").
  const digitMatch = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)
  const digit = digitMatch
    ? Number(digitMatch[1])
    : /^[1-9]$/.test(event.key)
      ? Number(event.key)
      : 0
  if (digit) return event.shiftKey ? { type: 'note', digit } : { type: 'input', digit }

  if (event.key === 'Backspace' || event.key === 'Delete' || event.key === '0')
    return { type: 'erase' }
  if (lower === 'n') return { type: 'toggleNotes' }
  if (lower === 'h') return { type: 'hint' }
  if (lower === 'u') return { type: 'undo' }
  if (lower === 'r') return { type: 'redo' }
  return null
}
