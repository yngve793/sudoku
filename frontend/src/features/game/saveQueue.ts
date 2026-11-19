/**
 * Pure decisions behind the autosave queue (unit-tested).
 *
 * Root cause of the reload-time 409s (confirmed with a request trace against
 * the real backend): on reload `beforeunload` sends a keepalive PATCH with
 * version N, the server applies it, but the navigation aborts the fetch on the
 * client side, so the page never learns version N+1. `pagehide` then flushed
 * again with the stale version N → 409. The fix: while the page is unloading,
 * a save whose outcome is unknown counts as delivered if it was sent with
 * `keepalive` (the browser finishes those after unload), and nothing is sent
 * again unless the content changed since that *sent* save.
 */

/** Browsers cap keepalive bodies (64 KiB in flight); stay well below it. */
export const KEEPALIVE_MAX_BYTES = 60_000

export type SaveOutcome = 'pending' | 'ok' | 'rejected' | 'unknown'

/** What the latest PATCH carried, and what became of it. */
export interface SentSave {
  /** Board revision (gameReducer `revision`) in that request. */
  revision: number
  /** Search-tree revision in that request (or the last saved one if not sent). */
  searchRevision: number
  keepalive: boolean
  /** `unknown`: no response (network error / aborted by navigation). */
  outcome: SaveOutcome
}

export interface PendingContent {
  revision: number
  searchRevision: number
}

/** Every save whose body fits is sent with keepalive, so a started save survives unload. */
export function keepaliveFits(bodyBytes: number): boolean {
  return bodyBytes < KEEPALIVE_MAX_BYTES
}

/** The content (not the timer) differs from what `sent` carried. */
export function contentChangedSince(sent: SentSave, now: PendingContent): boolean {
  return sent.revision !== now.revision || sent.searchRevision !== now.searchRevision
}

/**
 * While unloading, skip another save when the last one may already be on its
 * way (keepalive, pending or outcome unknown) and carried the current content.
 * Re-sending it would reuse a version the server may have consumed (→ 409).
 * Elapsed-time-only differences are not worth that risk.
 */
export function skipUnloadSave(
  unloading: boolean,
  sent: SentSave | null,
  now: PendingContent,
): boolean {
  if (!unloading || !sent) return false
  const mayHaveLanded =
    sent.outcome === 'ok' ||
    ((sent.outcome === 'pending' || sent.outcome === 'unknown') && sent.keepalive)
  return mayHaveLanded && !contentChangedSince(sent, now)
}
