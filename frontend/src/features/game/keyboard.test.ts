import { describe, expect, it } from 'vitest'
import { keyToCommand } from './keyboard'

const key = (k: string, extra: Partial<Parameters<typeof keyToCommand>[0]> = {}) =>
  keyToCommand({
    key: k,
    code: /^[0-9]$/.test(k) ? `Digit${k}` : '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...extra,
  })

describe('keyToCommand', () => {
  it.each([
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right'],
  ] as const)('%s moves %s', (k, direction) => {
    expect(key(k)).toEqual({ type: 'move', direction })
  })

  it('maps digits 1-9 to input, and shift+digit to note', () => {
    expect(key('7')).toEqual({ type: 'input', digit: 7 })
    expect(key('&', { code: 'Digit7', shiftKey: true })).toEqual({ type: 'note', digit: 7 })
    expect(key('3', { code: 'Numpad3' })).toEqual({ type: 'input', digit: 3 })
  })

  it('maps erase keys', () => {
    expect(key('Backspace')).toEqual({ type: 'erase' })
    expect(key('Delete')).toEqual({ type: 'erase' })
    expect(key('0')).toEqual({ type: 'erase' })
  })

  it('maps letters case-insensitively', () => {
    expect(key('n')).toEqual({ type: 'toggleNotes' })
    expect(key('N', { shiftKey: true })).toEqual({ type: 'toggleNotes' })
    expect(key('h')).toEqual({ type: 'hint' })
    expect(key('u')).toEqual({ type: 'undo' })
    expect(key('r')).toEqual({ type: 'redo' })
  })

  it('maps search-mode keys', () => {
    expect(key('s')).toEqual({ type: 'search' })
    expect(key('S', { shiftKey: true })).toEqual({ type: 'search' })
    expect(key('g')).toEqual({ type: 'guess' })
    expect(key('b')).toEqual({ type: 'branch' })
    expect(key('Escape')).toEqual({ type: 'cancel' })
  })

  it('maps undo/redo shortcuts', () => {
    expect(key('z', { ctrlKey: true })).toEqual({ type: 'undo' })
    expect(key('z', { metaKey: true, shiftKey: true })).toEqual({ type: 'redo' })
    expect(key('y', { ctrlKey: true })).toEqual({ type: 'redo' })
    expect(key('c', { ctrlKey: true })).toBeNull()
  })

  it('ignores alt combos and unrelated keys', () => {
    expect(key('5', { altKey: true })).toBeNull()
    expect(key('x')).toBeNull()
    expect(key('Tab')).toBeNull()
  })
})
