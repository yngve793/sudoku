import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, isApiError } from '../../api/client'
import { gamesApi } from '../../api/endpoints'
import type { Game, GameUpdateRequest, SearchTree } from '../../api/types'
import { toWireTree } from '../search/searchReducer'
import type { GameAction, GameState } from './gameReducer'
import { serializeGrid, serializeNotes } from './grid'
import { keepaliveFits, skipUnloadSave, type SentSave } from './saveQueue'

export const AUTOSAVE_DELAY_MS = 1000

/** Debug trace of every save, enabled with localStorage['sudoku.debug.autosave'] = '1'. */
function trace(...parts: unknown[]): void {
  try {
    if (localStorage.getItem('sudoku.debug.autosave') !== '1') return
  } catch {
    return
  }
  console.info('[autosave]', Math.round(performance.now()), ...parts)
}

export type SaveReason =
  'debounce' | 'visibilitychange' | 'pagehide' | 'beforeunload' | 'unmount' | 'explicit'

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
 * immediate flush when the tab is hidden or the page unloads. Saves use
 * `keepalive` whenever the body fits, so they complete even across unload.
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
  /** The latest PATCH sent and its outcome (see saveQueue). */
  const sentRef = useRef<SentSave | null>(null)
  /** Between beforeunload/pagehide and pageshow (bfcache) or becoming visible. */
  const unloadingRef = useRef(false)

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
    async (reason: SaveReason): Promise<void> => {
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
        // Keepalive whenever the body fits: a started save then always reaches
        // the server, even if the page unloads right after.
        const useKeepalive = keepaliveFits(JSON.stringify(body).length)
        const sent: SentSave = {
          revision: snapshot.revision,
          searchRevision: sendTree ? search.revision : savedSearchRevisionRef.current,
          keepalive: useKeepalive,
          outcome: 'pending',
        }
        sentRef.current = sent
        setStatus('saving')
        trace('start', reason, {
          keepalive: useKeepalive,
          version: body.version,
          current: body.current.slice(0, 12),
        })
        try {
          const game = await gamesApi.save(gameId, body, useKeepalive)
          sent.outcome = 'ok'
          trace('done', reason, { sent: body.version, received: game.version })
          versionRef.current = game.version
          savedElapsedRef.current = elapsed
          if (sendTree) savedSearchRevisionRef.current = search.revision
          callbacksRef.current.dispatch({ type: 'saved', revision: snapshot.revision })
          callbacksRef.current.onSaved?.(game)
          setStatus('saved')
          return
        } catch (error) {
          sent.outcome = error instanceof ApiError ? 'rejected' : 'unknown'
          trace('fail', reason, {
            sent: body.version,
            error:
              error instanceof ApiError ? `${error.status} ${error.code ?? ''}` : String(error),
          })
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
    async (reason: SaveReason = 'explicit'): Promise<void> => {
      window.clearTimeout(timerRef.current)
      trace('flush', reason, { inFlight: inFlightRef.current !== null })
      // Loop: several callers (pagehide, beforeunload, visibilitychange) may wait
      // on the same save; only one of them may start the next one, or two PATCHes
      // go out with the same version and the second gets a 409.
      while (inFlightRef.current) {
        await inFlightRef.current.catch(() => undefined)
      }
      if (!enabled || conflictRef.current || !needsSave()) return
      const current = searchRef.current
      const now = {
        revision: stateRef.current.revision,
        searchRevision:
          searchPending() && current ? current.revision : savedSearchRevisionRef.current,
      }
      if (skipUnloadSave(unloadingRef.current, sentRef.current, now)) {
        trace('skip', reason, { sent: sentRef.current })
        return
      }
      const run = saveOnce(reason).finally(() => {
        inFlightRef.current = null
      })
      inFlightRef.current = run
      await run
    },
    [enabled, needsSave, saveOnce, searchPending],
  )

  // Debounce after each content change (board or search tree).
  const searchRevision = search?.revision ?? 0
  useEffect(() => {
    if (!enabled || (!state.dirty && !searchPending())) return
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      flush('debounce').catch(() => {
        /* status shows the error; next change or flush retries */
      })
    }, AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(timerRef.current)
  }, [state.revision, state.dirty, searchRevision, enabled, flush, searchPending])

  // Flush when the tab is hidden or the page is going away.
  useEffect(() => {
    if (!enabled) return
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush('visibilitychange').catch(() => undefined)
      else unloadingRef.current = false
    }
    // beforeunload and pagehide both fire on reload/close: the first one sends,
    // the second sees the same content already sent and skips (saveQueue).
    const onPageHide = () => {
      unloadingRef.current = true
      flush('pagehide').catch(() => undefined)
    }
    const onBeforeUnload = () => {
      unloadingRef.current = true
      flush('beforeunload').catch(() => undefined)
    }
    // Back from the bfcache, or navigation cancelled: normal saving again.
    const onPageShow = () => {
      unloadingRef.current = false
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [enabled, flush])

  // Save progress when leaving the game screen inside the app.
  useEffect(() => () => void flush('unmount').catch(() => undefined), [flush])

  /** Resume sending the search tree after a rejection. */
  const allowSearchTree = useCallback(() => {
    searchBlockedRef.current = false
  }, [])

  return { status, flush, allowSearchTree }
}
