import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockBroadcastChannel } from '../../test/broadcast'
import { createTree } from './searchReducer'
import {
  GameSyncHost,
  HELLO_TIMEOUT_MS,
  TreeSyncClient,
  channelName,
  parseSyncMessage,
  type SnapshotInput,
  type SyncCommand,
  type TreeSyncState,
} from './sync'

const EMPTY = '0'.repeat(81)
const snapshot = (over: Partial<SnapshotInput['ui']> = {}): SnapshotInput => ({
  tree: createTree(EMPTY),
  ui: { selectedStep: null, mode: 'manual', searchActive: true, editable: true, ...over },
  auto_placements: 0,
})
const flush = () => new Promise((r) => setTimeout(r, 0))
const channel = () => new MockBroadcastChannel(channelName(7))

beforeEach(() => MockBroadcastChannel.reset())

describe('parseSyncMessage', () => {
  it('accepts every valid message', () => {
    const valid = [
      { type: 'hello', v: 1, from: 'tree' },
      { type: 'hello', v: 1, from: 'game' },
      { type: 'bye', v: 1, from: 'game' },
      { type: 'snapshot', v: 1, ...snapshot() },
      { type: 'snapshot', v: 1, ...snapshot({ techniques: { 'n2:3:4': 'Hidden Single' } }) },
      { type: 'snapshot', v: 1, ...snapshot(), tree: null },
      { type: 'select', v: 1, nodeId: 'n1', step: null },
      { type: 'select', v: 1, nodeId: 'n2', step: -1 },
      { type: 'toggleCollapse', v: 1, nodeId: 'n2', collapsed: true },
      { type: 'guess', v: 1, nodeId: 'n1', cell: 80, value: 9 },
      { type: 'branchAll', v: 1, nodeId: 'n1', cell: 0 },
      { type: 'deleteBranch', v: 1, nodeId: 'n2' },
    ]
    for (const m of valid) expect(parseSyncMessage(m)).toEqual(m)
  })

  it('ignores unknown, unversioned or malformed messages', () => {
    const bad: unknown[] = [
      null,
      'hello',
      [],
      { type: 'hello', from: 'tree' },
      { type: 'hello', v: 2, from: 'tree' },
      { type: 'hello', v: 1, from: 'evil' },
      { type: 'bye', v: 1, from: 'tree' },
      { type: 'nope', v: 1 },
      { type: 'guess', v: 1, nodeId: 'n1', cell: 81, value: 1 },
      { type: 'guess', v: 1, nodeId: 'n1', cell: 0, value: 0 },
      { type: 'guess', v: 1, cell: 0, value: 1 },
      { type: 'select', v: 1, nodeId: 'x'.repeat(37), step: null },
      { type: 'select', v: 1, nodeId: 'n1', step: 99 },
      { type: 'toggleCollapse', v: 1, nodeId: 'n1' },
      { type: 'branchAll', v: 1, nodeId: 'n1', cell: '3' },
      { type: 'deleteBranch', v: 1 },
      { type: 'snapshot', v: 1, ...snapshot(), auto_placements: -1 },
      { type: 'snapshot', v: 1, ...snapshot(), tree: { version: 1, nodes: [] } },
      { type: 'snapshot', v: 1, ...snapshot({ mode: 'turbo' as never }) },
      { type: 'snapshot', v: 1, ...snapshot({ techniques: { 'n2:3:4': 'Guess' as never } }) },
      { type: 'snapshot', v: 1, ...snapshot({ techniques: { bad: 'Naked Single' } }) },
      { type: 'snapshot', v: 1, tree: null, auto_placements: 0 },
    ]
    for (const m of bad) expect(parseSyncMessage(m)).toBeNull()
  })
})

describe('GameSyncHost', () => {
  it('says hello, deduplicates snapshots, answers a tree hello and runs valid commands', async () => {
    const commands: SyncCommand[] = []
    const tree = channel()
    const host = new GameSyncHost(channel(), (c) => commands.push(c))
    expect(MockBroadcastChannel.sent('hello')).toEqual([{ type: 'hello', v: 1, from: 'game' }])

    host.publish(snapshot())
    host.publish(snapshot()) // identical: not re-sent
    expect(MockBroadcastChannel.sent('snapshot')).toHaveLength(1)
    host.publish(snapshot({ selectedStep: 2 }))
    expect(MockBroadcastChannel.sent('snapshot')).toHaveLength(2)

    tree.postMessage({ type: 'hello', v: 1, from: 'tree' })
    await flush()
    expect(MockBroadcastChannel.sent('snapshot')).toHaveLength(3) // forced reply

    tree.postMessage({ type: 'guess', v: 1, nodeId: 'n1', cell: 3, value: 4 })
    tree.postMessage({ type: 'guess', v: 1, nodeId: 'n1', cell: 3 }) // malformed
    tree.postMessage({ type: 'snapshot', v: 1, ...snapshot() }) // not a command
    tree.postMessage({ type: 'rm -rf', v: 1 })
    await flush()
    expect(commands).toEqual([{ type: 'guess', v: 1, nodeId: 'n1', cell: 3, value: 4 }])

    host.close()
    expect(MockBroadcastChannel.sent('bye')).toEqual([{ type: 'bye', v: 1, from: 'game' }])
  })
})

describe('TreeSyncClient', () => {
  afterEach(() => vi.useRealTimers())

  function client() {
    const states: TreeSyncState[] = []
    const c = new TreeSyncClient(channel(), (s) => states.push(s))
    return { c, states }
  }

  it('goes live on a snapshot and never echoes it back', async () => {
    const game = channel()
    const { c, states } = client()
    c.start()
    expect(MockBroadcastChannel.sent()).toEqual([{ type: 'hello', v: 1, from: 'tree' }])
    game.postMessage({ type: 'snapshot', v: 1, ...snapshot() })
    await flush()
    expect(c.state.status).toBe('live')
    expect(states.at(-1)?.snapshot?.ui.selectedStep).toBeNull()

    // A snapshot that echoes our own selection does not trigger any message.
    const before = MockBroadcastChannel.log.length
    game.postMessage({ type: 'snapshot', v: 1, ...snapshot({ selectedStep: 1 }) })
    await flush()
    expect(MockBroadcastChannel.log.length).toBe(before + 1) // only the game's snapshot
    expect(c.state.snapshot?.ui.selectedStep).toBe(1)
    c.stop()
  })

  it('falls back to read-only when nobody answers, and back to live when a game tab appears', async () => {
    vi.useFakeTimers()
    const { c } = client()
    c.start()
    expect(c.state.status).toBe('connecting')
    expect(c.send({ type: 'deleteBranch', nodeId: 'n2' })).toBe(false)
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS + 1)
    expect(c.state.status).toBe('readonly')

    vi.useRealTimers()
    const game = channel()
    game.postMessage({ type: 'hello', v: 1, from: 'game' })
    game.postMessage({ type: 'snapshot', v: 1, ...snapshot() })
    await flush()
    expect(c.state.status).toBe('live')
    expect(c.send({ type: 'deleteBranch', nodeId: 'n2' })).toBe(true)
    expect(MockBroadcastChannel.sent('deleteBranch')).toEqual([
      { type: 'deleteBranch', v: 1, nodeId: 'n2' },
    ])

    game.postMessage({ type: 'bye', v: 1, from: 'game' })
    await flush()
    expect(c.state.status).toBe('readonly')
    c.ping() // "Reload": asks again
    expect(c.state.status).toBe('connecting')
    c.stop()
  })

  it('round-trips with a real host: commands in, snapshots out', async () => {
    const commands: SyncCommand[] = []
    const host = new GameSyncHost(channel(), (cmd) => commands.push(cmd))
    host.publish(snapshot())
    const { c } = client()
    c.start()
    await flush()
    await flush()
    expect(c.state.status).toBe('live')
    c.send({ type: 'select', nodeId: 'n1', step: null })
    await flush()
    expect(commands).toEqual([{ type: 'select', v: 1, nodeId: 'n1', step: null }])
    // Several tree tabs can listen at once.
    const second = client()
    second.c.start()
    await flush()
    await flush()
    expect(second.c.state.status).toBe('live')
    host.close()
    c.stop()
    second.c.stop()
  })
})
