/**
 * Cross-tab sync for search mode (PLAN.md §5.5 "Open in new tab").
 *
 * The **game tab is the single writer**: it owns the reducer state and autosave
 * and broadcasts versioned snapshots. Tree tabs send commands, which the game
 * tab applies through its normal actions, then broadcasts the new snapshot.
 * Channel: `BroadcastChannel("sudoku-search-<gameId>")`. Tokens never cross tabs.
 *
 * Every message is `{type, v: 1, ...}` and validated on receipt; anything
 * unknown or malformed is ignored.
 */
import type { SearchMode, SearchTree } from '../../api/types'
import { parseSearchTree } from './searchReducer'

export const SYNC_VERSION = 1
/** How long a tree tab waits for a game tab before going read-only. */
export const HELLO_TIMEOUT_MS = 1000

export const channelName = (gameId: number) => `sudoku-search-${gameId}`

export interface SnapshotUi {
  /** Implication step being viewed in the selected node (`null` = end of chain). */
  selectedStep: number | null
  mode: SearchMode
  /** The game tab is in search mode. */
  searchActive: boolean
  /** The game can still be edited (in progress, not paused). */
  editable: boolean
  /** Session-only techniques of auto placements, keyed `${nodeId}:${cell}:${value}`. */
  techniques?: Record<string, 'Naked Single' | 'Hidden Single'>
}

export type SyncMessage =
  | { type: 'hello'; v: 1; from: 'game' | 'tree' }
  | { type: 'bye'; v: 1; from: 'game' }
  | {
      type: 'snapshot'
      v: 1
      tree: SearchTree | null
      ui: SnapshotUi
      auto_placements: number
    }
  | { type: 'select'; v: 1; nodeId: string; step: number | null }
  | { type: 'toggleCollapse'; v: 1; nodeId: string; collapsed: boolean }
  | { type: 'guess'; v: 1; nodeId: string; cell: number; value: number }
  | { type: 'branchAll'; v: 1; nodeId: string; cell: number }
  | { type: 'deleteBranch'; v: 1; nodeId: string }

export type SyncCommand = Extract<
  SyncMessage,
  { type: 'select' | 'toggleCollapse' | 'guess' | 'branchAll' | 'deleteBranch' }
>
/** A command as built by a tree tab (the version is added when sending). */
export type CommandInput = SyncCommand extends infer C
  ? C extends SyncCommand
    ? Omit<C, 'v'>
    : never
  : never

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 36

/** Validates an incoming message; `null` for anything unknown or malformed. */
export function parseSyncMessage(raw: unknown): SyncMessage | null {
  if (!isObj(raw) || raw.v !== SYNC_VERSION || typeof raw.type !== 'string') return null
  const v = SYNC_VERSION
  switch (raw.type) {
    case 'hello':
      return raw.from === 'game' || raw.from === 'tree'
        ? { type: 'hello', v, from: raw.from }
        : null
    case 'bye':
      return raw.from === 'game' ? { type: 'bye', v, from: 'game' } : null
    case 'snapshot': {
      const ui = raw.ui
      if (!isObj(ui) || !isInt(raw.auto_placements, 0, Number.MAX_SAFE_INTEGER)) return null
      const step = ui.selectedStep
      if (step !== null && !isInt(step, -1, 80)) return null
      if (ui.mode !== 'manual' && ui.mode !== 'auto') return null
      if (typeof ui.searchActive !== 'boolean' || typeof ui.editable !== 'boolean') return null
      let techniques: SnapshotUi['techniques']
      if (ui.techniques !== undefined) {
        if (!isObj(ui.techniques)) return null
        techniques = {}
        for (const [key, value] of Object.entries(ui.techniques)) {
          if (!/^[^:]{1,36}:\d{1,2}:[1-9]$/.test(key)) return null
          if (value !== 'Naked Single' && value !== 'Hidden Single') return null
          techniques[key] = value
        }
      }
      let tree: SearchTree | null = null
      if (raw.tree !== null) {
        tree = parseSearchTree(raw.tree)
        if (!tree) return null
      }
      return {
        type: 'snapshot',
        v,
        tree,
        ui: {
          selectedStep: step,
          mode: ui.mode,
          searchActive: ui.searchActive,
          editable: ui.editable,
          ...(techniques ? { techniques } : {}),
        },
        auto_placements: raw.auto_placements,
      }
    }
    case 'select':
      return isId(raw.nodeId) && (raw.step === null || isInt(raw.step, -1, 80))
        ? { type: 'select', v, nodeId: raw.nodeId, step: raw.step }
        : null
    case 'toggleCollapse':
      return isId(raw.nodeId) && typeof raw.collapsed === 'boolean'
        ? { type: 'toggleCollapse', v, nodeId: raw.nodeId, collapsed: raw.collapsed }
        : null
    case 'guess':
      return isId(raw.nodeId) && isInt(raw.cell, 0, 80) && isInt(raw.value, 1, 9)
        ? { type: 'guess', v, nodeId: raw.nodeId, cell: raw.cell, value: raw.value }
        : null
    case 'branchAll':
      return isId(raw.nodeId) && isInt(raw.cell, 0, 80)
        ? { type: 'branchAll', v, nodeId: raw.nodeId, cell: raw.cell }
        : null
    case 'deleteBranch':
      return isId(raw.nodeId) ? { type: 'deleteBranch', v, nodeId: raw.nodeId } : null
    default:
      return null
  }
}

/** The subset of BroadcastChannel we use (injectable for tests). */
export interface SyncChannel {
  postMessage: (message: unknown) => void
  close: () => void
  onmessage: ((event: { data: unknown }) => void) | null
}

export function openChannel(gameId: number): SyncChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  return new BroadcastChannel(channelName(gameId)) as unknown as SyncChannel
}

// ---------- game tab ----------

export type SnapshotInput = Omit<Extract<SyncMessage, { type: 'snapshot' }>, 'type' | 'v'>

/**
 * Game-tab side: publishes snapshots (deduplicated) and hands validated
 * commands to `onCommand`. Answers a tree tab's `hello` with the latest snapshot.
 */
export class GameSyncHost {
  private last: SnapshotInput | null = null
  private lastSignature = ''
  private readonly channel: SyncChannel
  private readonly onCommand: (command: SyncCommand) => void

  constructor(channel: SyncChannel, onCommand: (command: SyncCommand) => void) {
    this.channel = channel
    this.onCommand = onCommand
    channel.onmessage = (event) => this.receive(event.data)
    this.post({ type: 'hello', v: SYNC_VERSION, from: 'game' })
  }

  /** Broadcasts a snapshot unless it is identical to the previous one. */
  publish(snapshot: SnapshotInput, force = false): void {
    const signature = JSON.stringify(snapshot)
    this.last = snapshot
    if (!force && signature === this.lastSignature) return
    this.lastSignature = signature
    this.post({ type: 'snapshot', v: SYNC_VERSION, ...snapshot })
  }

  /** Tell tree tabs this game tab is going away (they turn read-only). */
  bye(): void {
    this.post({ type: 'bye', v: SYNC_VERSION, from: 'game' })
  }

  close(): void {
    this.bye()
    this.channel.onmessage = null
    this.channel.close()
  }

  private receive(raw: unknown): void {
    const message = parseSyncMessage(raw)
    if (!message) return
    if (message.type === 'hello') {
      if (message.from === 'tree' && this.last) this.publish(this.last, true)
      return
    }
    if (message.type === 'snapshot' || message.type === 'bye') return
    this.onCommand(message)
  }

  private post(message: SyncMessage): void {
    try {
      this.channel.postMessage(message)
    } catch {
      /* channel closed */
    }
  }
}

// ---------- tree tab ----------

/**
 * Scheduler for the `hello` timeout. Tests replace `schedule` to fire the
 * timeout by hand, so read-only fallback never depends on real timing.
 */
export const syncTimers = {
  schedule: (fn: () => void, ms: number): (() => void) => {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
}

export type TreeSyncStatus = 'connecting' | 'live' | 'readonly'

export interface TreeSyncState {
  status: TreeSyncStatus
  snapshot: SnapshotInput | null
}

/**
 * Tree-tab side: pings with `hello`, follows snapshots, and falls back to
 * read-only when no game tab answers within `timeoutMs` or the game tab says
 * `bye`. It never sends anything in response to a snapshot (no echo loops).
 */
export class TreeSyncClient {
  state: TreeSyncState = { status: 'connecting', snapshot: null }
  private cancelTimer: (() => void) | undefined
  private readonly channel: SyncChannel
  private readonly onChange: (state: TreeSyncState) => void
  private readonly timeoutMs: number

  constructor(
    channel: SyncChannel,
    onChange: (state: TreeSyncState) => void,
    timeoutMs = HELLO_TIMEOUT_MS,
  ) {
    this.channel = channel
    this.onChange = onChange
    this.timeoutMs = timeoutMs
    channel.onmessage = (event) => this.receive(event.data)
  }

  start(): void {
    this.ping()
  }

  /** Ask for a fresh snapshot (e.g. "Reload"); goes read-only if nobody answers. */
  ping(): void {
    this.cancelTimer?.()
    this.post({ type: 'hello', v: SYNC_VERSION, from: 'tree' })
    this.cancelTimer = syncTimers.schedule(() => {
      if (this.state.status !== 'live') this.set({ ...this.state, status: 'readonly' })
    }, this.timeoutMs)
    if (this.state.status === 'readonly') this.set({ ...this.state, status: 'connecting' })
  }

  /** Sends a command if a game tab is live; returns whether it was sent. */
  send(command: CommandInput): boolean {
    if (this.state.status !== 'live') return false
    this.post({ ...command, v: SYNC_VERSION })
    return true
  }

  stop(): void {
    this.cancelTimer?.()
    this.channel.onmessage = null
    this.channel.close()
  }

  private receive(raw: unknown): void {
    const message = parseSyncMessage(raw)
    if (!message) return
    if (message.type === 'snapshot') {
      this.cancelTimer?.()
      const { type: _t, v: _v, ...snapshot } = message
      this.set({ status: 'live', snapshot })
    } else if (message.type === 'bye') {
      this.set({ ...this.state, status: 'readonly' })
    }
    // `hello` from a game tab is followed by its snapshot; commands are not for us.
  }

  private set(state: TreeSyncState): void {
    this.state = state
    this.onChange(state)
  }

  private post(message: SyncMessage): void {
    try {
      this.channel.postMessage(message)
    } catch {
      /* channel closed */
    }
  }
}
