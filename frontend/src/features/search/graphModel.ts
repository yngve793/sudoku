/**
 * The search graph's model (PLAN.md §5.5 "every inferred value is its own
 * graph node"): each tree node becomes its guess item followed by a chain of
 * one item per placement, in the order they were found. Child guesses hang
 * off the last item of the chain. Presentation only; the persisted
 * `SearchTree` is unchanged.
 *
 * Layout: leaves get consecutive horizontal slots in depth-first order and
 * parents are centred over their first and last child, so nodes never overlap
 * and edges never cross. Everything is iterative and O(n) so very deep chains
 * (500 tree nodes × 81 placements) are safe.
 */
import type { SearchNode, SearchTree } from '../../api/types'
import { cellName, parseGrid } from '../game/grid'
import { findContradiction } from './constraints'
import { allBoards, deadReason, describeNode, nodeLabel } from './searchReducer'

export const NODE_WIDTH = 72
export const NODE_HEIGHT = 30
export const SLOT_WIDTH = 104
export const LEVEL_HEIGHT = 56

export type GraphKind = 'root' | 'guess' | 'manual' | 'auto'

/** Techniques of auto placements seen this session, keyed by `techniqueKey`. */
export type TechniqueMap = ReadonlyMap<string, string>

export const techniqueKey = (nodeId: string, cell: number, value: number) =>
  `${nodeId}:${cell}:${value}`

export interface GraphItem {
  /** Tree node id for the guess/root item, `${nodeId}#${step}` for placements. */
  key: string
  nodeId: string
  /** -1 for the guess/root item, else the placement index. */
  step: number
  kind: GraphKind
  label: string
  ariaLabel: string
  title: string
  parentKey: string | null
  /** Visible graph children, in order. */
  children: string[]
  x: number
  y: number
  depth: number
  posInSet: number
  setSize: number
  /** The contradiction appears here (red ✗). */
  cross: boolean
  /** Last item of a solved node's chain (✓). */
  solved: boolean
  /** Below a ✗ (dimmed). */
  underDead: boolean
  /** Last visible item of its tree node (where children and branches hang). */
  chainEnd: boolean
  /** Guess/root items whose tree node has a chain or children. */
  collapsible: boolean
  collapsed: boolean
  /** Graph items folded away under a collapsed guess node. */
  hiddenCount: number
}

export interface GraphModel {
  /** Visible items in depth-first pre-order. */
  items: GraphItem[]
  byKey: Map<string, GraphItem>
  /** Last visible item of each tree node. */
  chainEndOf: Map<string, string>
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export const itemKey = (nodeId: string, step: number) => (step < 0 ? nodeId : `${nodeId}#${step}`)

/**
 * Graph key to highlight for tree node `node` viewed at `step` (`null` = full
 * state, i.e. the last item of its chain, or the guess if it has none or is folded).
 */
export function selectedItemKey(node: SearchNode, step: number | null): string {
  if (step !== null) return itemKey(node.id, step)
  return node.collapsed || node.placements.length === 0
    ? node.id
    : itemKey(node.id, node.placements.length - 1)
}

/** Step at which a dead node's contradiction first appears (-1 = the guess). */
function crossStep(node: SearchNode, parentBoard: readonly number[] | undefined): number {
  const last = node.placements.length - 1
  if (!node.contradiction || !parentBoard) return last
  const board = parentBoard.slice()
  if (node.choice) board[node.choice.cell] = node.choice.value
  if (findContradiction(board)) return -1
  for (let k = 0; k < node.placements.length; k++) {
    const p = node.placements[k]
    if (!p) break
    board[p.cell] = p.value
    if (findContradiction(board)) return k
  }
  return last
}

function placementLabel(
  node: SearchNode,
  step: number,
  techniques: TechniqueMap | undefined,
): { aria: string; title: string } {
  const p = node.placements[step]
  if (!p) return { aria: '', title: '' }
  const head = `${cellName(p.cell)} equals ${p.value}`
  const technique =
    p.source === 'auto' ? techniques?.get(techniqueKey(node.id, p.cell, p.value)) : undefined
  const how =
    p.source === 'manual'
      ? 'placed manually'
      : technique
        ? `implied by ${technique}`
        : 'implied (auto)'
  const after = node.choice
    ? `${cellName(node.choice.cell)} equals ${node.choice.value}`
    : 'the start'
  return {
    aria: `${head}, ${how}, step ${step + 1} of ${node.placements.length} after ${after}`,
    title: `${cellName(p.cell)}=${p.value} · ${p.source === 'manual' ? 'manual' : (technique ?? 'auto')}`,
  }
}

export function buildGraph(tree: SearchTree, techniques?: TechniqueMap): GraphModel {
  const kids = new Map<string, SearchNode[]>()
  let root: SearchNode | undefined
  for (const n of tree.nodes) {
    if (n.parent_id === null) {
      root = n
      continue
    }
    const list = kids.get(n.parent_id)
    if (list) list.push(n)
    else kids.set(n.parent_id, [n])
  }
  const items: GraphItem[] = []
  const byKey = new Map<string, GraphItem>()
  const chainEndOf = new Map<string, string>()
  if (!root) return { items, byKey, chainEndOf, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }

  const boards = allBoards(tree)
  const rootBoard = parseGrid(tree.root_board)

  // Graph items folded under each collapsed node (its chain + whole subtree).
  const folded = (id: string): number => {
    let count = 0
    const stack = [...(kids.get(id) ?? [])]
    for (let n = stack.pop(); n; n = stack.pop()) {
      count += 1 + n.placements.length
      stack.push(...(kids.get(n.id) ?? []))
    }
    return count
  }

  // Iterative pre-order over tree nodes; each emits its guess item + chain.
  interface Frame {
    node: SearchNode
    parentKey: string | null
    depth: number
    pos: number
    size: number
    underDead: boolean
  }
  const stack: Frame[] = [
    { node: root, parentKey: null, depth: 0, pos: 1, size: 1, underDead: false },
  ]
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const { node } = frame
    const children = kids.get(node.id) ?? []
    const collapsible = node.placements.length > 0 || children.length > 0
    const collapsed = collapsible && node.collapsed
    const dead = node.status === 'dead'
    const cross = dead
      ? crossStep(node, node.parent_id ? boards.get(node.parent_id) : rootBoard)
      : -2
    const chain = collapsed ? 0 : node.placements.length
    const lastStep = chain - 1
    const reason = deadReason(node)

    let parentKey = frame.parentKey
    let underDead = frame.underDead
    for (let step = -1; step <= lastStep; step++) {
      const key = itemKey(node.id, step)
      const isGuess = step === -1
      const p = isGuess ? undefined : node.placements[step]
      const end = step === lastStep
      let ariaLabel: string
      let title: string
      if (isGuess) {
        ariaLabel = describeNode(node)
        if (collapsed) {
          const n = folded(node.id) + node.placements.length
          ariaLabel += ` Collapsed, ${n} hidden ${n === 1 ? 'node' : 'nodes'}.`
        }
        title = nodeLabel(node)
      } else {
        const text = placementLabel(node, step, techniques)
        ariaLabel = text.aria
        if (cross === step && reason) ariaLabel += `, contradiction: ${reason}`
        if (end && node.status === 'solved') ariaLabel += ', board solved'
        ariaLabel += '.'
        title = text.title
      }
      const item: GraphItem = {
        key,
        nodeId: node.id,
        step,
        kind: isGuess ? (node.parent_id === null ? 'root' : 'guess') : (p?.source ?? 'manual'),
        label: isGuess ? nodeLabel(node) : `${cellName(p?.cell ?? 0)}=${p?.value ?? 0}`,
        ariaLabel,
        title,
        parentKey,
        children: [],
        x: 0,
        y: (frame.depth + step + 1) * LEVEL_HEIGHT,
        depth: frame.depth + step + 1,
        posInSet: isGuess ? frame.pos : 1,
        setSize: isGuess ? frame.size : 1,
        cross: cross === step,
        solved: end && node.status === 'solved',
        underDead,
        chainEnd: end,
        collapsible: isGuess && collapsible,
        collapsed: isGuess && collapsed,
        hiddenCount: isGuess && collapsed ? folded(node.id) + node.placements.length : 0,
      }
      // A dead node whose chain is folded still shows its ✗ on the guess.
      if (isGuess && collapsed && dead) item.cross = true
      items.push(item)
      byKey.set(key, item)
      if (parentKey) byKey.get(parentKey)?.children.push(key)
      if (item.cross) underDead = true
      parentKey = key
    }
    chainEndOf.set(node.id, parentKey ?? node.id)

    if (!collapsed) {
      const endDepth = frame.depth + chain
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i]
        if (!child) continue
        stack.push({
          node: child,
          parentKey,
          depth: endDepth + 1,
          pos: i + 1,
          size: children.length,
          underDead: underDead || dead,
        })
      }
    }
  }

  // x: post-order over the graph items (iterative).
  let nextSlot = 0
  const post: { key: string; visited: boolean }[] = [{ key: items[0]?.key ?? '', visited: false }]
  for (let top = post.at(-1); top; top = post.at(-1)) {
    const item = byKey.get(top.key)
    if (!item) {
      post.pop()
      continue
    }
    if (!top.visited) {
      top.visited = true
      for (let i = item.children.length - 1; i >= 0; i--) {
        const child = item.children[i]
        if (child) post.push({ key: child, visited: false })
      }
      continue
    }
    post.pop()
    const first = byKey.get(item.children[0] ?? '')
    const last = byKey.get(item.children.at(-1) ?? '')
    if (first && last) item.x = (first.x + last.x) / 2
    else item.x = nextSlot++ * SLOT_WIDTH
  }

  let minX = Infinity
  let maxX = -Infinity
  let maxY = 0
  for (const item of items) {
    minX = Math.min(minX, item.x)
    maxX = Math.max(maxX, item.x)
    maxY = Math.max(maxY, item.y)
  }
  return {
    items,
    byKey,
    chainEndOf,
    bounds: {
      minX: minX - NODE_WIDTH / 2,
      minY: -NODE_HEIGHT / 2,
      maxX: maxX + NODE_WIDTH / 2,
      maxY: maxY + NODE_HEIGHT / 2,
    },
  }
}
