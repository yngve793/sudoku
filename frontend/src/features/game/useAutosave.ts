import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../api/client'
import { gamesApi } from '../../api/endpoints'
import type { Game } from '../../api/types'
import type { GameAction, GameState } from './gameReducer'
import { serializeGrid, serializeNotes } from './grid'

export const AUTOSAVE_DELAY_MS = 1000

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface AutosaveOptions {
  gameId: number
  initialVersion: number
  initialElapsed: number
  state: GameState
  dispatch: (action: GameAction) => void
  elapsedRef: { readonly current: number }
  /** Disable once the game is completed. */
  enabled: boolean
  /** Called on a 409 version conflict; the caller should refetch the game. */
  onConflict: () => void
  onSaved?: (game: Game) => void
}

/**
 * Debounced PATCH /games/{id} with optimistic-concurrency `version`, plus an
 * immediate keepalive flush when the tab is hidden or the page unloads.
 */
export function useAutosave({
  gameId,
  initialVersion,
  initialElapsed,
  state,
  dispatch,
  elapsedRef,
  enabled,
  onConflict,
  onSaved,
}: AutosaveOptions) {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const versionRef = useRef(initialVersion)
  const stateRef = useRef(state)
  const savedElapsedRef = useRef(initialElapsed)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const conflictRef = useRef(false)
  const callbacksRef = useRef({ onConflict, onSaved, dispatch })

  useEffect(() => {
    stateRef.current = state
    callbacksRef.current = { onConflict, onSaved, dispatch }
  })

  const needsSave = useCallback(
    () => stateRef.current.dirty || elapsedRef.current !== savedElapsedRef.current,
    [elapsedRef],
  )

  const saveOnce = useCallback(
    async (keepalive: boolean) => {
      const snapshot = stateRef.current
      const elapsed = elapsedRef.current
      setStatus('saving')
      try {
        const game = await gamesApi.save(
          gameId,
          {
            current: serializeGrid(snapshot.cells),
            notes: serializeNotes(snapshot.notes),
            elapsed_seconds: elapsed,
            version: versionRef.current,
          },
          keepalive,
        )
        versionRef.current = game.version
        savedElapsedRef.current = elapsed
        callbacksRef.current.dispatch({ type: 'saved', revision: snapshot.revision })
        callbacksRef.current.onSaved?.(game)
        setStatus('saved')
      } catch (error) {
        if (isApiError(error, 'version_conflict')) {
          conflictRef.current = true
          setStatus('idle')
          callbacksRef.current.onConflict()
          return
        }
        setStatus('error')
        throw error
      }
    },
    [gameId, elapsedRef],
  )

  /** Saves now (if anything changed) and resolves when the server has it. */
  const flush = useCallback(
    async (keepalive = false): Promise<void> => {
      window.clearTimeout(timerRef.current)
      if (inFlightRef.current) {
        await inFlightRef.current.catch(() => undefined)
      }
      if (!enabled || conflictRef.current || !needsSave()) return
      const run = saveOnce(keepalive).finally(() => {
        inFlightRef.current = null
      })
      inFlightRef.current = run
      await run
    },
    [enabled, needsSave, saveOnce],
  )

  // Debounce after each content change.
  useEffect(() => {
    if (!enabled || !state.dirty) return
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      flush().catch(() => {
        /* status shows the error; next change or flush retries */
      })
    }, AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(timerRef.current)
  }, [state.revision, state.dirty, enabled, flush])

  // Flush when the tab is hidden or the page is going away.
  useEffect(() => {
    if (!enabled) return
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush(true).catch(() => undefined)
    }
    const onUnload = () => {
      flush(true).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onUnload)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onUnload)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [enabled, flush])

  // Save progress when leaving the game screen inside the app.
  useEffect(() => () => void flush().catch(() => undefined), [flush])

  return { status, flush }
}
