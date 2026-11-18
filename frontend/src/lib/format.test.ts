import { describe, expect, it } from 'vitest'
import { describeDuration, formatDate, formatDuration } from './format'

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [75, '1:15'],
    [3725, '1:02:05'],
    [-3, '0:00'],
  ])('%i -> %s', (s, out) => expect(formatDuration(s)).toBe(out))
})

describe('describeDuration', () => {
  it.each([
    [0, '0 seconds'],
    [1, '1 second'],
    [75, '1 minute 15 seconds'],
    [3600, '1 hour'],
    [7322, '2 hours 2 minutes 2 seconds'],
  ])('%i -> %s', (s, out) => expect(describeDuration(s)).toBe(out))
})

describe('formatDate', () => {
  it('returns empty for invalid dates', () => expect(formatDate('nope')).toBe(''))
  it('formats valid dates', () => expect(formatDate('2026-01-02T00:00:00Z')).toMatch(/2026/))
})
