import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTimer } from './useTimer'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useTimer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  it('counts from the initial value while running', () => {
    const { result } = renderHook(() => useTimer(10, true))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.elapsed).toBe(13)
    expect(result.current.elapsedRef.current).toBe(13)
  })

  it('does not run when stopped', () => {
    const { result } = renderHook(() => useTimer(0, false))
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.elapsed).toBe(0)
  })

  it('pauses while the tab is hidden', () => {
    const { result } = renderHook(() => useTimer(0, true))
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    act(() => {
      setVisibility('hidden')
    })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.elapsed).toBe(2)
    expect(result.current.ticking).toBe(false)
    act(() => {
      setVisibility('visible')
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.elapsed).toBe(3)
  })
})
