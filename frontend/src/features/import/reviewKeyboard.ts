import { keyToCommand } from '../game/keyboard'
import type { ReviewAction } from './reviewReducer'

interface KeyLike {
  key: string
  code: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * Review-grid keys: the board's arrows / 1–9 / Backspace, plus `T` to toggle
 * given ↔ handwritten and Enter to accept a flagged reading as it is.
 */
export function reviewKeyToAction(event: KeyLike): ReviewAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key.toLowerCase() === 't') return { type: 'toggleKind' }
  if (event.key === 'Enter') return { type: 'confirm' }
  const command = keyToCommand(event)
  if (!command) return null
  switch (command.type) {
    case 'move':
      return { type: 'move', direction: command.direction }
    case 'input':
    case 'note':
      return { type: 'input', digit: command.digit }
    case 'erase':
      return { type: 'erase' }
    default:
      return null
  }
}
