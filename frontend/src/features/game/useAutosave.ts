import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, isApiError } from '../../api/client'
import { gamesApi } from '../../api/endpoints'
import type { Game, GameUpdateRequest, SearchTree } from '../../api/types'
import { toWireTree } from '../search/searchReducer'
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
  /** Search-mode tree; sent only when `revision` changed since the last save. */
  search?: { tree: SearchTree | null; revision: number }
  /**
   * The server rejected the search tree (422). Saving continues without it
   * until `allowSearchTree()` is called (e.g. after resetting the tree).
   */
  onSearchTreeRejected?: (error: unknown) => void
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
  search,
  onSearchTreeRejected,
}: AutosaveOptions) {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const versionRef = useRef(initialVersion)
  const stateRef = useRef(state)
  const savedElapsedRef = useRef(initialElapsed)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const conflictRef = useRef(false)
  const callbacksRef = useRef({ onConflict, onSaved, dispatch, onSearchTreeRejected })
  const searchRef = useRef(search)
  const savedSearchRevisionRef = useRef(search?.revision ?? 0)
  const searchBlockedRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
    searchRef.current = search
    callbacksRef.current = { onConflict, onSaved, dispatch, onSearchTreeRejected }
  })

  const searchPending = useCallback(() => {
    const current = searchRef.current
    return (
      !searchBlockedRef.current &&
      current !== undefined &&
      current.revision !== savedSearchRevisionRef.current
    )
  }, [])

  const needsSave = useCallback(
    () =>
      stateRef.current.dirty || elapsedRef.current !== savedElapsedRef.current || searchPending(),
    [elapsedRef, searchPending],
  )

  const saveOnce = useCallback(
    async (keepalive: boolean): Promise<void> => {
      // At most two attempts: the second one only after the tree was rejected.
      for (;;) {
        const snapshot = stateRef.current
        const elapsed = elapsedRef.current
        const search = searchRef.current
        const sendTree = searchPending() && search !== undefined
        const body: GameUpdateRequest = {
          current: serializeGrid(snapshot.cells),
          notes: serializeNotes(snapshot.notes),
          elapsed_seconds: elapsed,
          version: versionRef.current,
        }
        if (sendTree) body.search_tree = search.tree ? toWireTree(search.tree) : null
        setStatus('saving')
        try {
          const game = await gamesApi.save(gameId, body, keepalive)
          versionRef.current = game.version
          savedElapsedRef.current = elapsed
          if (sendTree) savedSearchRevisionRef.current = search.revision
          callbacksRef.current.dispatch({ type: 'saved', revision: snapshot.revision })
          callbacksRef.current.onSaved?.(game)
          setStatus('saved')
          return
        } catch (error) {
          if (isApiError(error, 'version_conflict')) {
            conflictRef.current = true
            setStatus('idle')
            callbacksRef.current.onConflict()
            return
          }
          // A rejected tree must not block saving the board (and must not loop):
          // stop sending it and save the rest right away.
          if (sendTree && error instanceof ApiError && error.status === 422) {
            searchBlockedRef.current = true
            callbacksRef.current.onSearchTreeRejected?.(error)
            continue
          }
          setStatus('error')
          throw error
        }
      }
    },
    [gameId, elapsedRef, searchPending],
  )

  /** Saves now (if anything changed) and resolves when the server has it. */
  const flush = useCallback(
    async (keepalive = false): Promise<void> => {
      window.clearTimeout(timerRef.current)
      // Loop: several callers (pagehide, beforeunload, visibilitychange) may wait
      // on the same save; only one of them may start the next one, or two PATCHes
      // go out with the same version and the second gets a 409.
      while (inFlightRef.current) {
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

  // Debounce after each content change (board or search tree).
  const searchRevision = search?.revision ?? 0
  useEffect(() => {
    if (!enabled || (!state.dirty && !searchPending())) return
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      flush().catch(() => {
        /* status shows the error; next change or flush retries */
      })
    }, AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(timerRef.current)
  }, [state.revision, state.dirty, searchRevision, enabled, flush, searchPending])

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

  /** Resume sending the search tree after a rejection. */
  const allowSearchTree = useCallback(() => {
    searchBlockedRef.current = false
  }, [])

  return { status, flush, allowSearchTree }
}
