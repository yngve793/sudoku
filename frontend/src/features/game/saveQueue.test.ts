import { describe, expect, it } from 'vitest'
import {
  KEEPALIVE_MAX_BYTES,
  contentChangedSince,
  keepaliveFits,
  skipUnloadSave,
  type SentSave,
} from './saveQueue'

const sent = (over: Partial<SentSave> = {}): SentSave => ({
  revision: 5,
  searchRevision: 2,
  keepalive: true,
  outcome: 'unknown',
  ...over,
})
const same = { revision: 5, searchRevision: 2 }

describe('keepaliveFits', () => {
  it('uses keepalive for bodies under the browser limit only', () => {
    expect(keepaliveFits(2_000)).toBe(true)
    expect(keepaliveFits(KEEPALIVE_MAX_BYTES - 1)).toBe(true)
    expect(keepaliveFits(KEEPALIVE_MAX_BYTES)).toBe(false)
    expect(keepaliveFits(256 * 1024)).toBe(false) // a big search tree
  })
})

describe('contentChangedSince', () => {
  it('compares board and search revisions, not the timer', () => {
    expect(contentChangedSince(sent(), same)).toBe(false)
    expect(contentChangedSince(sent(), { ...same, revision: 6 })).toBe(true)
    expect(contentChangedSince(sent(), { ...same, searchRevision: 3 })).toBe(true)
  })
})

describe('skipUnloadSave', () => {
  it('never skips while the page is not unloading, or before any save', () => {
    expect(skipUnloadSave(false, sent(), same)).toBe(false)
    expect(skipUnloadSave(true, null, same)).toBe(false)
  })

  it('skips the second unload flush (beforeunload then pagehide) for the same content', () => {
    // The keepalive PATCH was aborted client-side by the navigation: outcome unknown.
    expect(skipUnloadSave(true, sent({ outcome: 'unknown' }), same)).toBe(true)
    // Still in flight when the second event fires.
    expect(skipUnloadSave(true, sent({ outcome: 'pending' }), same)).toBe(true)
    // Acknowledged: only the timer could differ, not worth a request.
    expect(skipUnloadSave(true, sent({ outcome: 'ok', keepalive: false }), same)).toBe(true)
  })

  it('sends when the content changed since the last sent save', () => {
    expect(skipUnloadSave(true, sent(), { ...same, revision: 6 })).toBe(false)
    expect(skipUnloadSave(true, sent(), { ...same, searchRevision: 9 })).toBe(false)
  })

  it('re-sends when the earlier save may not have reached the server', () => {
    // Too big for keepalive and cut off by the unload: it may be lost, so retry.
    expect(skipUnloadSave(true, sent({ keepalive: false, outcome: 'unknown' }), same)).toBe(false)
    expect(skipUnloadSave(true, sent({ keepalive: false, outcome: 'pending' }), same)).toBe(false)
    // The server answered with an error: the content is not saved.
    expect(skipUnloadSave(true, sent({ outcome: 'rejected' }), same)).toBe(false)
  })
})
