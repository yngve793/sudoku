import { useEffect, useRef, useState } from 'react'

/**
 * Elapsed-seconds counter that only runs while `running` is true and the tab
 * is visible. `elapsedRef` always holds the latest value (for autosave).
 */
export function useTimer(initialSeconds: number, running: boolean) {
  const [elapsed, setElapsed] = useState(initialSeconds)
  const elapsedRef = useRef(initialSeconds)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  const ticking = running && visible
  useEffect(() => {
    if (!ticking) return
    const id = window.setInterval(() => {
      elapsedRef.current += 1
      setElapsed(elapsedRef.current)
    }, 1000)
    return () => window.clearInterval(id)
  }, [ticking])

  return { elapsed, elapsedRef, ticking }
}
