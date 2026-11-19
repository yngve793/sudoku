import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError } from '../../api/client'
import { gamesApi } from '../../api/endpoints'
import type { Game, SearchTree } from '../../api/types'
import { Alert } from '../../components/Alert'
import { Spinner } from '../../components/Spinner'
import { errorMessage } from '../../lib/errors'
import { cellName } from '../game/grid'
import { candidates } from './constraints'
import { selectedItemKey, type GraphItem } from './graphModel'
import { SearchGraph } from './SearchGraph'
import {
  MAX_NODES,
  deadReason,
  findNode,
  nodeBoard,
  nodeLabel,
  parseSearchTree,
} from './searchReducer'
import { TreeSyncClient, openChannel, type CommandInput, type TreeSyncState } from './sync'

/** `/game/:gameId/tree`: the search tree full-screen, synced with the game tab. */
export function TreePage() {
  const { gameId } = useParams()
  const id = Number(gameId)
  const valid = Number.isInteger(id) && id > 0
  const query = useQuery({
    queryKey: ['game-tree', id],
    queryFn: () => gamesApi.get(id),
    enabled: valid,
    gcTime: 0,
    staleTime: Infinity,
  })

  if (!valid || (query.error instanceof ApiError && query.error.status === 404)) {
    return (
      <div className="page page--narrow">
        <Alert tone="error" title="Game not found">
          This game doesn&apos;t exist or belongs to someone else.
        </Alert>
        <Link to="/" className="button button--primary">
          Back to home
        </Link>
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="page page--narrow">
        <Alert tone="error">{errorMessage(query.error)}</Alert>
      </div>
    )
  }
  if (!query.data) return <Spinner label="Loading search tree" />
  return (
    <TreeView key={query.dataUpdatedAt} game={query.data} onReload={() => void query.refetch()} />
  )
}

function TreeView({ game, onReload }: { game: Game; onReload: () => void }) {
  const finished = game.status !== 'in_progress'
  const saved = useMemo(() => parseSearchTree(game.search_tree), [game.search_tree])
  const [sync, setSync] = useState<TreeSyncState>({
    // No BroadcastChannel (very old browsers): only the saved tree, read-only.
    status: finished || typeof BroadcastChannel === 'undefined' ? 'readonly' : 'connecting',
    snapshot: null,
  })
  const clientRef = useRef<TreeSyncClient | null>(null)
  // Read-only mode keeps its own selection / collapse state (nothing is sent).
  const [local, setLocal] = useState<{ tree: SearchTree | null; step: number | null }>({
    tree: saved,
    step: null,
  })
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (finished) return
    const channel = openChannel(game.id)
    if (!channel) return
    const client = new TreeSyncClient(channel, (state) => {
      setSync(state)
      // Going read-only keeps showing the last live state, not the stale load.
      if (state.status === 'readonly' && state.snapshot)
        setLocal({ tree: state.snapshot.tree, step: state.snapshot.ui.selectedStep })
    })
    clientRef.current = client
    client.start()
    return () => {
      client.stop()
      clientRef.current = null
    }
  }, [game.id, finished])

  const live = sync.status === 'live' && sync.snapshot !== null
  const snapshot = live ? sync.snapshot : null
  const tree = snapshot ? snapshot.tree : local.tree
  const step = snapshot ? snapshot.ui.selectedStep : local.step
  const techniques = useMemo(
    () => new Map(Object.entries(snapshot?.ui.techniques ?? {})),
    [snapshot],
  )
  const node = tree ? (findNode(tree, tree.selected_node_id) ?? null) : null
  const editable = live && (snapshot?.ui.editable ?? false)

  const send = useCallback((command: CommandInput) => {
    if (!clientRef.current?.send(command)) setToast('The game tab is not connected.')
  }, [])

  const onSelectItem = useCallback(
    (item: GraphItem) => {
      const nextStep = item.chainEnd ? null : item.step
      if (live) send({ type: 'select', nodeId: item.nodeId, step: nextStep })
      else
        setLocal((prev) =>
          prev.tree
            ? { tree: { ...prev.tree, selected_node_id: item.nodeId }, step: nextStep }
            : prev,
        )
    },
    [live, send],
  )

  const onToggleCollapse = useCallback(
    (nodeId: string) => {
      const target = tree ? findNode(tree, nodeId) : undefined
      if (!target) return
      if (live) send({ type: 'toggleCollapse', nodeId, collapsed: !target.collapsed })
      else
        setLocal((prev) =>
          prev.tree
            ? {
                step: null,
                tree: {
                  ...prev.tree,
                  nodes: prev.tree.nodes.map((n) =>
                    n.id === nodeId ? { ...n, collapsed: !n.collapsed } : n,
                  ),
                },
              }
            : prev,
        )
    },
    [tree, live, send],
  )

  return (
    <div className="tree-page">
      <header className="tree-page__head">
        <h1 className="tree-page__title">Search tree</h1>
        <Link to={`/game/${game.id}`} className="button button--ghost button--small">
          Back to the game
        </Link>
      </header>

      <SyncNotice
        status={sync.status}
        finished={finished}
        searchActive={snapshot?.ui.searchActive ?? true}
        onReload={() => {
          onReload()
          clientRef.current?.ping()
        }}
      />
      {toast && (
        <Alert tone="warning">
          {toast}{' '}
          <button type="button" className="link-button" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </Alert>
      )}

      {tree && node ? (
        <div className="tree-page__layout">
          <div className="tree-page__graph">
            <SearchGraph
              tree={tree}
              selectedKey={selectedItemKey(node, step)}
              techniques={techniques}
              onSelectItem={onSelectItem}
              onToggleCollapse={onToggleCollapse}
              tall
            />
          </div>
          <aside className="tree-page__side">
            <NodeSummary
              tree={tree}
              nodeId={node.id}
              step={step}
              autoPlacements={snapshot?.auto_placements ?? game.auto_placements}
              cost={game.search_costs.auto_placement}
            />
            <TreeActions tree={tree} nodeId={node.id} disabled={!editable} onCommand={send} />
          </aside>
        </div>
      ) : (
        <p className="tree-page__empty">
          No search tree yet. Press <kbd>S</kbd> in the game tab to start one.
        </p>
      )}
    </div>
  )
}

function SyncNotice({
  status,
  finished,
  searchActive,
  onReload,
}: {
  status: TreeSyncState['status']
  finished: boolean
  searchActive: boolean
  onReload: () => void
}) {
  if (finished)
    return (
      <Alert tone="info" title="Game finished">
        This game is no longer in progress. Showing its saved search tree (read-only).
      </Alert>
    )
  if (status === 'connecting')
    return (
      <p className="tree-page__status" role="status">
        Connecting to the game tab…
      </p>
    )
  if (status === 'readonly')
    return (
      <Alert tone="warning" title="Read-only">
        No open game tab for this game, so this is the last saved tree and changes are disabled.
        Open the game in another tab to go live.{' '}
        <button type="button" className="link-button" onClick={onReload}>
          Reload saved tree
        </button>
      </Alert>
    )
  return (
    <p className="tree-page__status tree-page__status--live" role="status">
      <span aria-hidden="true">●</span> Live: synced with the game tab.
      {!searchActive && ' Search mode is off there; Guess, Branch and Delete turn it on.'}
    </p>
  )
}

function NodeSummary(props: {
  tree: SearchTree
  nodeId: string
  step: number | null
  autoPlacements: number
  cost: number
}) {
  const node = findNode(props.tree, props.nodeId)
  if (!node) return null
  const reason = deadReason(node)
  return (
    <section className="tree-summary" aria-label="Selected node">
      <p>
        <strong>{nodeLabel(node)}</strong>
        {node.placements.length > 0 && (
          <>
            {' '}
            · {node.placements.length}{' '}
            {node.placements.length === 1 ? 'implication' : 'implications'}
          </>
        )}
        {props.step !== null && (
          <> · viewing {props.step < 0 ? 'the guess' : `step ${props.step + 1}`}</>
        )}
      </p>
      <p className="tree-summary__status">
        {reason ? `✗ Dead: ${reason}.` : node.status === 'solved' ? '✓ Solved.' : 'Open.'}
      </p>
      <p className="tree-summary__cost">
        {props.tree.mode === 'auto' ? 'Auto mode' : 'Manual mode'} · auto placements{' '}
        {props.autoPlacements} (−{props.autoPlacements * props.cost} points)
      </p>
    </section>
  )
}

const NINE = [1, 2, 3, 4, 5, 6, 7, 8, 9]

/** Guess / branch / delete for the selected node: a small row-column-value picker. */
function TreeActions({
  tree,
  nodeId,
  disabled,
  onCommand,
}: {
  tree: SearchTree
  nodeId: string
  disabled: boolean
  onCommand: (command: CommandInput) => void
}) {
  const formId = useId()
  const node = findNode(tree, nodeId)
  const board = useMemo(() => nodeBoard(tree, nodeId), [tree, nodeId])
  const firstEmpty = Math.max(0, board.indexOf(0))
  const [row, setRow] = useState(Math.floor(firstEmpty / 9) + 1)
  const [col, setCol] = useState((firstEmpty % 9) + 1)
  const [value, setValue] = useState(0)
  if (!node) return null
  const cell = (row - 1) * 9 + (col - 1)
  const filled = board[cell] !== 0
  const options = candidates(board, cell)
  const dead = node.status === 'dead'
  const full = tree.nodes.length >= MAX_NODES
  const guessValue = value !== 0 ? value : (options[0] ?? 0)
  const blocked = disabled || dead || full || filled

  return (
    <section className="tree-actions" aria-labelledby={`${formId}-title`}>
      <h2 id={`${formId}-title`} className="tree-actions__title">
        From {nodeLabel(node)}
      </h2>
      <div className="tree-actions__picker">
        <label className="field field--inline">
          <span className="field__label">Row</span>
          <select
            className="field__input"
            value={row}
            onChange={(e) => setRow(Number(e.target.value))}
          >
            {NINE.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span className="field__label">Column</span>
          <select
            className="field__input"
            value={col}
            onChange={(e) => setCol(Number(e.target.value))}
          >
            {NINE.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span className="field__label">Value</span>
          <select
            className="field__input"
            value={guessValue}
            onChange={(e) => setValue(Number(e.target.value))}
          >
            {NINE.map((n) => (
              <option key={n} value={n}>
                {n}
                {options.includes(n) ? '' : ' (no candidate)'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="tree-actions__hint" aria-live="polite">
        {filled
          ? `${cellName(cell)} is already filled in this node.`
          : options.length
            ? `Candidates for ${cellName(cell)}: ${options.join(', ')}`
            : `${cellName(cell)} has no candidates.`}
      </p>
      <div className="tree-actions__buttons">
        <button
          type="button"
          className="button button--primary button--small"
          disabled={blocked || !guessValue}
          onClick={() => onCommand({ type: 'guess', nodeId, cell, value: guessValue })}
        >
          Guess {cellName(cell)}={guessValue}
        </button>
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={
            blocked || options.length === 0 || tree.nodes.length + options.length > MAX_NODES
          }
          onClick={() => onCommand({ type: 'branchAll', nodeId, cell })}
        >
          Branch on all ({options.length})
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          disabled={disabled || node.parent_id === null}
          onClick={() => onCommand({ type: 'deleteBranch', nodeId })}
        >
          Delete branch
        </button>
      </div>
      {dead && <p className="tree-actions__hint">This node is dead: it cannot get children.</p>}
      {full && <p className="tree-actions__hint">The tree is full ({MAX_NODES} nodes).</p>}
    </section>
  )
}
