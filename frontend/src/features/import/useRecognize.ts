import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError } from '../../api/client'
import { importsApi } from '../../api/endpoints'
import type { Corner, Recognition } from '../../api/types'
import { recognizeErrorMessage } from './importErrors'

export type RecognizePhase =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number | null }
  /** Upload finished; the server is reading the grid. */
  | { kind: 'reading' }
  | { kind: 'error'; message: string; cancelled: boolean }

/** `POST /imports/recognize` with progress and cancel. */
export function useRecognize() {
  const [phase, setPhase] = useState<RecognizePhase>({ kind: 'idle' })
  const controller = useRef<AbortController | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const run = useCallback(
    async (image: Blob, corners: readonly Corner[] | null): Promise<Recognition | null> => {
      controller.current?.abort()
      const ac = new AbortController()
      controller.current = ac
      setPhase({ kind: 'uploading', progress: null })
      try {
        const result = await importsApi.recognize(image, corners, {
          signal: ac.signal,
          onProgress: (fraction) => {
            if (ac.signal.aborted) return
            setPhase(
              fraction >= 1 ? { kind: 'reading' } : { kind: 'uploading', progress: fraction },
            )
          },
        })
        if (controller.current === ac) controller.current = null
        setPhase({ kind: 'idle' })
        return result
      } catch (error) {
        if (controller.current === ac) controller.current = null
        setPhase({
          kind: 'error',
          message: recognizeErrorMessage(error, corners !== null),
          cancelled: isAbortError(error),
        })
        return null
      }
    },
    [],
  )

  const cancel = useCallback(() => controller.current?.abort(), [])
  const reset = useCallback(() => setPhase({ kind: 'idle' }), [])
  const fail = useCallback(
    (message: string) => setPhase({ kind: 'error', message, cancelled: false }),
    [],
  )
  const busy = phase.kind === 'uploading' || phase.kind === 'reading'

  return { phase, busy, run, cancel, reset, fail }
}
