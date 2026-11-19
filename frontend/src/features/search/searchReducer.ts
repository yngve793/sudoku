/**
 * Search mode ("what-if" exploration tree, PLAN.md §5.5) as a pure reducer.
 *
 * - A node's board = `root_board` + every choice and placement on the path from
 *   the root to that node (applied in order; a later entry wins a cell).
 * - Status is recomputed from scratch after every change:
 *   - a node whose board has a contradiction is `dead`;
 *   - a node with `branch_cell` is `dead` when every candidate of that cell has
 *     a child with that choice and all of those children are dead (recursively);
 *   - a complete board without contradiction is `solved`; anything else `open`.
 * - In auto mode the reducer queues node ids in `pending`; the UI drains the
 *   queue by calling the propagate endpoint and dispatching `autoResult`.
 */
import type {
  Contradiction,
  SearchChoice,
  SearchMode,
  SearchNode,
  SearchPlacement,
  SearchTree,
} from '../../api/types'
import { CELL_COUNT, cellName, parseGrid, serializeGrid, type Cells } from '../game/grid'
import { candidates, findContradiction } from './constraints'

export const ROOT_ID = 'n1'
/** Server-side limit (PATCH validation). */
export const MAX_NODES = 500

export interface SearchState {
  tree: SearchTree | null
  /** Node ids waiting for auto propagation (not persisted). */
  pending: readonly string[]
  /** Bumped on every change that should be saved. */
  revision: number
}

export interface CellValue {
  cell: number
  value: number
}

export type SearchAction =
  /** Restore a saved tree (validated; invalid input gives no tree). */
  | { type: 'load'; tree: unknown }
  /** New tree whose root is a snapshot of the main board (also "reset tree"). */
  | { type: 'create'; rootBoard: string }
  | { type: 'clear' }
  | { type: 'select'; nodeId: string }
  /** New child of the selected node with choice {cell, value}. */
  | { type: 'guess'; cell: number; value: number }
  /** One child of the selected node per candidate of `cell`. */
  | { type: 'branch'; cell: number }
  /** Manual placement in the selected node (same value again removes it). */
  | { type: 'place'; cell: number; value: number }
  /** Remove the selected node's manual placement in `cell` (and later auto ones). */
  | { type: 'erase'; cell: number }
  | {
      type: 'autoResult'
      nodeId: string
      placements: readonly CellValue[]
      contradiction: Contradiction | null
    }
  /** Propagation for `nodeId` failed or was skipped: drop it from the queue. */
  | { type: 'autoDone'; nodeId: string }
  /** Delete a node and its subtree (defaults to the selected node; not the root). */
  | { type: 'delete'; nodeId?: string }
  | { type: 'setMode'; mode: SearchMode }
  | { type: 'collapse'; nodeId: string; collapsed?: boolean }

export function createSearchState(): SearchState {
  return { tree: null, pending: [], revision: 0 }
}

// ---------- tree helpers (pure) ----------

const isIndex = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < CELL_COUNT
const isDigit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 9

export function findNode(tree: SearchTree, id: string): SearchNode | undefined {
  return tree.nodes.find((n) => n.id === id)
}

export function childrenOf(tree: SearchTree, id: string): SearchNode[] {
  return tree.nodes.filter((n) => n.parent_id === id)
}

export function rootOf(tree: SearchTree): SearchNode {
  const root = tree.nodes.find((n) => n.parent_id === null)
  if (!root) throw new Error('search tree without root')
  return root
}

/** Nodes from the root down to `id` (inclusive); `[]` if unknown. */
export function pathTo(tree: SearchTree, id: string): SearchNode[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]))
  const path: SearchNode[] = []
  let node = byId.get(id)
  while (node && path.length <= tree.nodes.length) {
    path.unshift(node)
    node = node.parent_id === null ? undefined : byId.get(node.parent_id)
  }
  return path
}

/** Every choice and placement on the path to `id`, in order. */
export function pathEntries(tree: SearchTree, id: string): CellValue[] {
  const entries: CellValue[] = []
  for (const node of pathTo(tree, id)) {
    if (node.choice) entries.push({ cell: node.choice.cell, value: node.choice.value })
    for (const p of node.placements) entries.push({ cell: p.cell, value: p.value })
  }
  return entries
}

function applyEntries(base: Cells, node: SearchNode): number[] {
  const board = base.slice()
  if (node.choice) board[node.choice.cell] = node.choice.value
  for (const p of node.placements) board[p.cell] = p.value
  return board
}

/** Board of every node, keyed by id (one pass from the root). */
export function allBoards(tree: SearchTree): Map<string, number[]> {
  const boards = new Map<string, number[]>()
  const kids = new Map<string | null, SearchNode[]>()
  for (const n of tree.nodes) {
    const list = kids.get(n.parent_id)
    if (list) list.push(n)
    else kids.set(n.parent_id, [n])
  }
  const root = parseGrid(tree.root_board)
  const stack: [SearchNode, number[]][] = (kids.get(null) ?? []).map((n) => [n, root])
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [node, parentBoard] = top
    const board = applyEntries(parentBoard, node)
    boards.set(node.id, board)
    for (const child of kids.get(node.id) ?? []) stack.push([child, board])
  }
  return boards
}

/**
 * Board of node `id` up to and including `step` of its chain: -1 = just the
 * choice, k = after placement k. `null` (or a step past the end) = full board.
 */
export function nodeBoardAt(tree: SearchTree, id: string, step: number | null): number[] {
  const path = pathTo(tree, id)
  const last = path.at(-1)
  if (!last || step === null || step >= last.placements.length - 1) return nodeBoard(tree, id)
  let board = parseGrid(tree.root_board)
  for (const node of path.slice(0, -1)) board = applyEntries(board, node)
  return applyEntries(board, { ...last, placements: last.placements.slice(0, step + 1) })
}

export function nodeBoard(tree: SearchTree, id: string): number[] {
  let board = parseGrid(tree.root_board)
  for (const node of pathTo(tree, id)) board = applyEntries(board, node)
  return board
}

/** Recomputes contradiction and status for every node (see module doc). */
export function recompute(tree: SearchTree): SearchTree {
  const boards = allBoards(tree)
  const byId = new Map<string, SearchNode>()
  for (const node of tree.nodes) {
    const board = boards.get(node.id) ?? []
    const contradiction = findContradiction(board)
    const status = contradiction ? 'dead' : board.every((v) => v !== 0) ? 'solved' : 'open'
    byId.set(node.id, { ...node, contradiction, status })
  }
  // Upward propagation: children before parents (post-order).
  const kids = new Map<string, SearchNode[]>()
  for (const n of byId.values()) {
    if (n.parent_id === null) continue
    const list = kids.get(n.parent_id)
    if (list) list.push(n)
    else kids.set(n.parent_id, [n])
  }
  const visit = (id: string, depth: number) => {
    const node = byId.get(id)
    if (!node || depth > byId.size) return
    for (const child of kids.get(id) ?? []) visit(child.id, depth + 1)
    if (node.status === 'dead' || node.branch_cell === null) return
    const cell = node.branch_cell
    const options = candidates(boards.get(id) ?? [], cell)
    if (!options.length) return
    const children = (kids.get(id) ?? []).map((c) => byId.get(c.id) ?? c)
    const allDead = options.every((value) => {
      const forValue = children.filter((c) => c.choice?.cell === cell && c.choice.value === value)
      return forValue.length > 0 && forValue.every((c) => c.status === 'dead')
    })
    if (allDead) byId.set(id, { ...node, status: 'dead' })
  }
  visit(rootOf(tree).id, 0)
  return { ...tree, nodes: tree.nodes.map((n) => byId.get(n.id) ?? n) }
}

function nextNodeId(tree: SearchTree): string {
  let max = 0
  for (const n of tree.nodes) {
    const m = /^n(\d+)$/.exec(n.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `n${max + 1}`
}

function newNode(id: string, parentId: string | null, choice: SearchChoice | null): SearchNode {
  return {
    id,
    parent_id: parentId,
    choice,
    placements: [],
    status: 'open',
    contradiction: null,
    branch_cell: null,
    collapsed: false,
  }
}

export function createTree(rootBoard: string, mode: SearchMode = 'manual'): SearchTree {
  parseGrid(rootBoard) // validates
  return recompute({
    version: 1,
    root_board: rootBoard,
    mode,
    selected_node_id: ROOT_ID,
    nodes: [newNode(ROOT_ID, null, null)],
  })
}

/** Ids of `id` and all its descendants. */
export function subtreeIds(tree: SearchTree, id: string): Set<string> {
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const n of tree.nodes) {
      if (n.parent_id !== null && ids.has(n.parent_id) && !ids.has(n.id)) {
        ids.add(n.id)
        grew = true
      }
    }
  }
  return ids
}

/** Validates an untrusted (persisted) tree; returns `null` if unusable. */
export function parseSearchTree(raw: unknown): SearchTree | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<Record<keyof SearchTree, unknown>>
  if (t.version !== 1 || typeof t.root_board !== 'string' || !/^[0-9]{81}$/.test(t.root_board))
    return null
  if (!Array.isArray(t.nodes)) return null
  const nodes: SearchNode[] = []
  const ids = new Set<string>()
  for (const item of t.nodes as unknown[]) {
    if (!item || typeof item !== 'object') return null
    const n = item as Partial<Record<keyof SearchNode, unknown>>
    if (typeof n.id !== 'string' || !n.id || n.id.length > 36 || ids.has(n.id)) return null
    if (n.parent_id !== null && typeof n.parent_id !== 'string') return null
    let choice: SearchChoice | null = null
    if (n.choice !== null && n.choice !== undefined) {
      const c = n.choice as Partial<SearchChoice>
      if (!isIndex(c.cell) || !isDigit(c.value)) return null
      choice = { cell: c.cell, value: c.value }
    }
    const placements: SearchPlacement[] = []
    for (const p of Array.isArray(n.placements) ? (n.placements as unknown[]) : []) {
      const q = (p ?? {}) as Partial<SearchPlacement>
      if (!isIndex(q.cell) || !isDigit(q.value)) return null
      placements.push({
        cell: q.cell,
        value: q.value,
        source: q.source === 'auto' ? 'auto' : 'manual',
      })
    }
    ids.add(n.id)
    nodes.push({
      id: n.id,
      parent_id: n.parent_id ?? null,
      choice,
      placements,
      status: 'open',
      contradiction: null,
      branch_cell: isIndex(n.branch_cell) ? n.branch_cell : null,
      collapsed: n.collapsed === true,
    })
  }
  const roots = nodes.filter((n) => n.parent_id === null)
  const root = roots[0]
  if (roots.length !== 1 || !root || root.choice || root.placements.length) return null
  if (nodes.some((n) => n.parent_id !== null && (!ids.has(n.parent_id) || !n.choice))) return null
  const base: SearchTree = {
    version: 1,
    root_board: t.root_board,
    mode: t.mode === 'auto' ? 'auto' : 'manual',
    selected_node_id: root.id,
    nodes,
  }
  // Drop anything not reachable from the root (cycles).
  const reachable = subtreeIds(base, root.id)
  const kept = nodes.filter((n) => reachable.has(n.id))
  const selected =
    typeof t.selected_node_id === 'string' && reachable.has(t.selected_node_id)
      ? t.selected_node_id
      : root.id
  return recompute({ ...base, nodes: kept, selected_node_id: selected })
}

// ---------- labels ----------

export function nodeLabel(node: SearchNode): string {
  return node.choice ? `${cellName(node.choice.cell)}=${node.choice.value}` : 'Start'
}

/** Why a node is dead, e.g. "7 appears twice in row 3" (no trailing period). */
export function deadReason(node: SearchNode): string | null {
  if (node.status !== 'dead') return null
  if (node.contradiction) return node.contradiction.explanation.replace(/\.$/, '')
  if (node.branch_cell !== null) return `every option for ${cellName(node.branch_cell)} fails`
  return 'contradiction'
}

/** Screen-reader text, e.g. "r3c5 equals 7, dead: 7 appears twice in row 3." */
export function describeNode(node: SearchNode): string {
  const head = node.choice
    ? `${cellName(node.choice.cell)} equals ${node.choice.value}`
    : 'Start position'
  const parts = [head]
  const n = node.placements.length
  if (n) parts.push(`${n} ${n === 1 ? 'implication' : 'implications'}`)
  const reason = deadReason(node)
  if (reason) return `${parts.join(', ')}, dead: ${reason}.`
  if (node.status === 'solved') parts.push('solved')
  return `${parts.join(', ')}.`
}

// ---------- reducer ----------

function changed(state: SearchState, tree: SearchTree | null, pending = state.pending) {
  return { tree, pending, revision: state.revision + 1 }
}

function enqueue(pending: readonly string[], ids: readonly string[]): string[] {
  return [...pending, ...ids.filter((id) => !pending.includes(id))]
}

/** Expands every ancestor of `id` so it is visible in the graph. */
function reveal(tree: SearchTree, id: string): SearchNode[] {
  const ancestors = new Set(
    pathTo(tree, id)
      .slice(0, -1)
      .map((n) => n.id),
  )
  return tree.nodes.map((n) =>
    ancestors.has(n.id) && n.collapsed ? { ...n, collapsed: false } : n,
  )
}

function guess(state: SearchState, tree: SearchTree, cell: number, value: number): SearchState {
  if (!isIndex(cell) || !isDigit(value)) return state
  const parent = findNode(tree, tree.selected_node_id)
  if (!parent || parent.status === 'dead') return state
  if (nodeBoard(tree, parent.id)[cell] !== 0) return state
  const existing = childrenOf(tree, parent.id).find(
    (c) => c.choice?.cell === cell && c.choice.value === value,
  )
  if (existing) {
    const next = { ...tree, selected_node_id: existing.id, nodes: reveal(tree, existing.id) }
    return changed(state, next)
  }
  if (tree.nodes.length >= MAX_NODES) return state
  const id = nextNodeId(tree)
  const nodes = [
    ...tree.nodes.map((n) => (n.id === parent.id ? { ...n, collapsed: false } : n)),
    newNode(id, parent.id, { cell, value }),
  ]
  const next = recompute({ ...tree, nodes, selected_node_id: id })
  return changed(state, next, tree.mode === 'auto' ? enqueue(state.pending, [id]) : state.pending)
}

function branch(state: SearchState, tree: SearchTree, cell: number): SearchState {
  if (!isIndex(cell)) return state
  const parent = findNode(tree, tree.selected_node_id)
  if (!parent || parent.status === 'dead') return state
  const options = candidates(nodeBoard(tree, parent.id), cell)
  if (!options.length) return state
  const kids = childrenOf(tree, parent.id)
  const missing = options.filter(
    (v) => !kids.some((c) => c.choice?.cell === cell && c.choice.value === v),
  )
  if (tree.nodes.length + missing.length > MAX_NODES) return state
  let working: SearchTree = tree
  const created: string[] = []
  for (const value of missing) {
    const id = nextNodeId(working)
    created.push(id)
    working = { ...working, nodes: [...working.nodes, newNode(id, parent.id, { cell, value })] }
  }
  const nodes = working.nodes.map((n) =>
    n.id === parent.id ? { ...n, branch_cell: cell, collapsed: false } : n,
  )
  const next = recompute({ ...working, nodes })
  return changed(
    state,
    next,
    tree.mode === 'auto' ? enqueue(state.pending, created) : state.pending,
  )
}

function withPlacements(tree: SearchTree, id: string, placements: SearchPlacement[]): SearchTree {
  return recompute({
    ...tree,
    nodes: tree.nodes.map((n) => (n.id === id ? { ...n, placements } : n)),
  })
}

/** Placements before `index`, plus manual ones after it (auto ones may depend on it). */
function truncateFrom(placements: readonly SearchPlacement[], index: number): SearchPlacement[] {
  return [
    ...placements.slice(0, index),
    ...placements.slice(index + 1).filter((p) => p.source === 'manual'),
  ]
}

function place(state: SearchState, tree: SearchTree, cell: number, value: number): SearchState {
  if (!isIndex(cell) || !isDigit(value)) return state
  const node = findNode(tree, tree.selected_node_id)
  if (!node?.parent_id) return state
  const own = node.placements.findIndex((p) => p.cell === cell)
  const ownPlacement = node.placements[own]
  let placements: SearchPlacement[]
  if (ownPlacement?.source === 'manual') {
    const rest = truncateFrom(node.placements, own)
    // Same digit again removes it (like the main board).
    placements =
      ownPlacement.value === value
        ? rest
        : [
            ...rest.slice(0, own),
            { cell, value, source: 'manual' },
            ...rest.slice(own).filter((p) => p.cell !== cell),
          ]
  } else {
    if (nodeBoard(tree, node.id)[cell] !== 0) return state
    placements = [...node.placements, { cell, value, source: 'manual' }]
  }
  const removed = ownPlacement?.source === 'manual' && ownPlacement.value === value
  const next = withPlacements(tree, node.id, placements)
  const queue = tree.mode === 'auto' && !removed ? enqueue(state.pending, [node.id]) : state.pending
  return changed(state, next, queue)
}

function erase(state: SearchState, tree: SearchTree, cell: number): SearchState {
  const node = findNode(tree, tree.selected_node_id)
  if (!node) return state
  const own = node.placements.findIndex((p) => p.cell === cell && p.source === 'manual')
  if (own < 0) return state
  return changed(state, withPlacements(tree, node.id, truncateFrom(node.placements, own)))
}

function autoResult(
  state: SearchState,
  tree: SearchTree,
  action: Extract<SearchAction, { type: 'autoResult' }>,
): SearchState {
  const pending = state.pending.filter((id) => id !== action.nodeId)
  const node = findNode(tree, action.nodeId)
  if (!node?.parent_id) return { ...state, pending }
  const board = nodeBoard(tree, node.id)
  const added: SearchPlacement[] = []
  for (const p of action.placements) {
    if (!isIndex(p.cell) || !isDigit(p.value) || board[p.cell] !== 0) continue
    board[p.cell] = p.value
    added.push({ cell: p.cell, value: p.value, source: 'auto' })
  }
  let next = withPlacements(tree, node.id, [...node.placements, ...added])
  // The client check normally agrees (same semantics); trust the server otherwise.
  const after = findNode(next, node.id)
  if (after && !after.contradiction && action.contradiction) {
    next = {
      ...next,
      nodes: next.nodes.map((n) =>
        n.id === node.id ? { ...n, contradiction: action.contradiction, status: 'dead' } : n,
      ),
    }
  }
  return changed(state, next, pending)
}

function remove(state: SearchState, tree: SearchTree, nodeId: string): SearchState {
  const node = findNode(tree, nodeId)
  if (!node?.parent_id) return state
  const gone = subtreeIds(tree, nodeId)
  const parentId = node.parent_id
  let nodes = tree.nodes.filter((n) => !gone.has(n.id))
  nodes = nodes.map((n) => {
    if (n.id !== parentId || n.branch_cell === null) return n
    const cell = n.branch_cell
    const stillBranched = nodes.some((c) => c.parent_id === parentId && c.choice?.cell === cell)
    return stillBranched ? n : { ...n, branch_cell: null }
  })
  const selected = gone.has(tree.selected_node_id) ? parentId : tree.selected_node_id
  const next = recompute({ ...tree, nodes, selected_node_id: selected })
  return changed(
    state,
    next,
    state.pending.filter((id) => !gone.has(id)),
  )
}

function collapse(
  state: SearchState,
  tree: SearchTree,
  nodeId: string,
  value: boolean | undefined,
): SearchState {
  const node = findNode(tree, nodeId)
  // Collapsible: anything below it in the graph (a chain of placements or children).
  if (!node || (!node.placements.length && !childrenOf(tree, nodeId).length)) return state
  const collapsed = value ?? !node.collapsed
  if (collapsed === node.collapsed) return state
  const nodes = tree.nodes.map((n) => (n.id === nodeId ? { ...n, collapsed } : n))
  // Keep the selection visible: a hidden selected node moves up to the collapsed one.
  const hidden = collapsed && subtreeIds(tree, nodeId).has(tree.selected_node_id)
  const selected = hidden ? nodeId : tree.selected_node_id
  return changed(state, { ...tree, nodes, selected_node_id: selected })
}

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  if (action.type === 'load') {
    return { tree: parseSearchTree(action.tree), pending: [], revision: state.revision }
  }
  if (action.type === 'create') return changed(state, createTree(action.rootBoard), [])
  if (action.type === 'clear') return state.tree ? changed(state, null, []) : state
  const tree = state.tree
  if (!tree) return state
  switch (action.type) {
    case 'select': {
      if (!findNode(tree, action.nodeId) || tree.selected_node_id === action.nodeId) return state
      const nodes = reveal(tree, action.nodeId)
      return changed(state, { ...tree, nodes, selected_node_id: action.nodeId })
    }
    case 'guess':
      return guess(state, tree, action.cell, action.value)
    case 'branch':
      return branch(state, tree, action.cell)
    case 'place':
      return place(state, tree, action.cell, action.value)
    case 'erase':
      return erase(state, tree, action.cell)
    case 'autoResult':
      return autoResult(state, tree, action)
    case 'autoDone':
      return state.pending.includes(action.nodeId)
        ? { ...state, pending: state.pending.filter((id) => id !== action.nodeId) }
        : state
    case 'delete':
      return remove(state, tree, action.nodeId ?? tree.selected_node_id)
    case 'setMode':
      return tree.mode === action.mode
        ? state
        : changed(
            state,
            { ...tree, mode: action.mode },
            action.mode === 'manual' ? [] : state.pending,
          )
    case 'collapse':
      return collapse(state, tree, action.nodeId, action.collapsed)
  }
}

// ---------- selectors ----------

export function selectedNode(state: SearchState): SearchNode | null {
  return state.tree ? (findNode(state.tree, state.tree.selected_node_id) ?? null) : null
}

/** Board of the selected node as an 81-char string. */
export function selectedBoard(tree: SearchTree): string {
  return serializeGrid(nodeBoard(tree, tree.selected_node_id))
}

export type CellOrigin = 'choice' | 'manual' | 'auto'

export interface CellMark {
  origin: CellOrigin
  /** Entry belongs to the selected node itself (not an ancestor). */
  own: boolean
}

/** How each non-root cell on the selected node's board was filled. */
export function cellMarks(
  tree: SearchTree,
  nodeId = tree.selected_node_id,
  step: number | null = null,
): Map<number, CellMark> {
  const marks = new Map<number, CellMark>()
  const path = pathTo(tree, nodeId)
  path.forEach((node, i) => {
    const own = i === path.length - 1
    if (node.choice) marks.set(node.choice.cell, { origin: 'choice', own })
    const placements = own && step !== null ? node.placements.slice(0, step + 1) : node.placements
    for (const p of placements) marks.set(p.cell, { origin: p.source, own })
  })
  return marks
}

export const canApply = (node: SearchNode | null): boolean =>
  node !== null && node.parent_id !== null && node.status !== 'dead'

/**
 * The tree exactly as the backend's strict `SearchTree` schema expects it:
 * every field present, nothing extra (unknown keys are rejected with 422).
 */
export function toWireTree(tree: SearchTree): SearchTree {
  return {
    version: 1,
    root_board: tree.root_board,
    mode: tree.mode,
    selected_node_id: tree.selected_node_id,
    nodes: tree.nodes.map((n) => ({
      id: n.id,
      parent_id: n.parent_id,
      choice: n.choice ? { cell: n.choice.cell, value: n.choice.value } : null,
      placements: n.placements.map((p) => ({ cell: p.cell, value: p.value, source: p.source })),
      status: n.status,
      contradiction: n.contradiction
        ? {
            kind: n.contradiction.kind,
            cells: [...n.contradiction.cells],
            digit: n.contradiction.digit,
            unit: n.contradiction.unit,
            explanation: n.contradiction.explanation.slice(0, 500),
          }
        : null,
      branch_cell: n.branch_cell,
      collapsed: n.collapsed,
    })),
  }
}
