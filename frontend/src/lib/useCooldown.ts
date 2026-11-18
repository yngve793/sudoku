import { useCallback, useEffect, useState } from 'react'

/** Seconds-based cooldown for "resend" style buttons. */
export function useCooldown(seconds: number, startActive = false) {
  const [remaining, setRemaining] = useState(startActive ? seconds : 0)

  useEffect(() => {
    if (remaining <= 0) return
    const id = window.setTimeout(() => setRemaining((r) => r - 1), 1000)
    return () => window.clearTimeout(id)
  }, [remaining])

  const start = useCallback(() => setRemaining(seconds), [seconds])
  return { remaining, active: remaining > 0, start }
}
