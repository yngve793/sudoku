/**
 * Turns the graph items (graphModel) into something to draw, in two layouts:
 *
 * - **expanded**: one box per graph item, edges between all of them;
 * - **compact** (default): every maximal run of items in which each item has a
 *   unique direct child is merged into one *chain card* — a tight vertical list
 *   with one row per value. A branch point (2+ children) or a leaf ends a card;
 *   edges connect cards only. Cards over `LONG_CARD` rows show their first and
 *   last `CARD_EDGE_ROWS` rows plus "… n more" unless opened or "pinned" (the
 *   selected / focused row is in the hidden part).
 *
 * Both layouts are O(n) and iterative.
 */
import { NODE_HEIGHT, NODE_WIDTH, type GraphItem, type GraphModel } from './graphModel'

export type GraphLayoutMode = 'compact' | 'expanded'

export const ROW_HEIGHT = 22
export const CARD_WIDTH = 112
export const CARD_PAD = 5
export const CARD_SLOT = 136
export const CARD_GAP = 34
export const LONG_CARD = 8
export const CARD_EDGE_ROWS = 3

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface CardRow {
  /** Graph item shown in this row, or a "… n more" placeholder. */
  item: GraphItem | null
  more: number
  /** Row centre, absolute. */
  y: number
}

export interface Box {
  key: string
  kind: 'node' | 'card'
  /** Centre x, top y. */
  x: number
  y: number
  w: number
  h: number
  items: GraphItem[]
  rows: CardRow[]
  /** Long card currently showing every row. */
  open: boolean
  long: boolean
}

export interface Edge {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  dim: boolean
}

export interface RenderModel {
  mode: GraphLayoutMode
  boxes: Box[]
  edges: Edge[]
  /** Where each item is drawn (hidden rows map to their "… more" row). */
  pos: Map<string, Rect>
  /** Card containing each item (compact) or the item's own box. */
  boxOf: Map<string, string>
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

const EDGE_GAP = 4

function boundsOf(boxes: Box[]) {
  if (!boxes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x - b.w / 2)
    maxX = Math.max(maxX, b.x + b.w / 2)
    minY = Math.min(minY, b.y)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { minX, minY, maxX, maxY }
}

export function expandedModel(graph: GraphModel): RenderModel {
  const boxes: Box[] = []
  const pos = new Map<string, Rect>()
  const boxOf = new Map<string, string>()
  for (const item of graph.items) {
    const box: Box = {
      key: item.key,
      kind: 'node',
      x: item.x,
      y: item.y - NODE_HEIGHT / 2,
      w: NODE_WIDTH,
      h: NODE_HEIGHT,
      items: [item],
      rows: [],
      open: true,
      long: false,
    }
    boxes.push(box)
    pos.set(item.key, { x: item.x, y: item.y, w: NODE_WIDTH, h: NODE_HEIGHT })
    boxOf.set(item.key, item.key)
  }
  const edges: Edge[] = []
  for (const item of graph.items) {
    const parent = item.parentKey ? graph.byKey.get(item.parentKey) : undefined
    if (!parent) continue
    edges.push({
      key: item.key,
      x1: parent.x,
      y1: parent.y + NODE_HEIGHT / 2,
      x2: item.x,
      y2: item.y - NODE_HEIGHT / 2 - EDGE_GAP,
      dim: item.underDead || item.cross,
    })
  }
  return { mode: 'expanded', boxes, edges, pos, boxOf, bounds: boundsOf(boxes) }
}

/**
 * @param openCards cards the user expanded ("… n more" clicked)
 * @param pinned item keys that must be visible (selection, focus)
 */
export function compactModel(
  graph: GraphModel,
  openCards: ReadonlySet<string> = new Set(),
  pinned: readonly (string | null | undefined)[] = [],
): RenderModel {
  // 1. Cards: a card starts at the root or at a child of a branch point and
  //    continues while the current item has exactly one child.
  interface Card {
    key: string
    items: GraphItem[]
    children: string[]
    x: number
    y: number
    h: number
  }
  const cards = new Map<string, Card>()
  const cardOfItem = new Map<string, string>()
  const order: Card[] = []
  for (const item of graph.items) {
    const parent = item.parentKey ? graph.byKey.get(item.parentKey) : undefined
    let card: Card | undefined
    if (parent?.children.length === 1) {
      card = cards.get(cardOfItem.get(parent.key) ?? '')
    } else {
      card = { key: item.key, items: [], children: [], x: 0, y: 0, h: 0 }
      cards.set(card.key, card)
      order.push(card)
    }
    if (!card) continue
    card.items.push(item)
    cardOfItem.set(item.key, card.key)
  }
  for (const card of order) {
    const last = card.items.at(-1)
    if (last && last.children.length !== 1) card.children = [...last.children]
  }

  // 2. Rows (long cards are shortened unless open or pinned).
  const pinnedSet = new Set(pinned.filter((k): k is string => typeof k === 'string'))
  const rowsOf = new Map<string, { item: GraphItem | null; more: number }[]>()
  const openOf = new Map<string, boolean>()
  for (const card of order) {
    const n = card.items.length
    const long = n > LONG_CARD
    const hiddenPart = card.items.slice(CARD_EDGE_ROWS, n - CARD_EDGE_ROWS)
    const open = !long || openCards.has(card.key) || hiddenPart.some((i) => pinnedSet.has(i.key))
    openOf.set(card.key, open)
    const rows = open
      ? card.items.map((item) => ({ item, more: 0 }))
      : [
          ...card.items.slice(0, CARD_EDGE_ROWS).map((item) => ({ item, more: 0 })),
          { item: null, more: hiddenPart.length },
          ...card.items.slice(n - CARD_EDGE_ROWS).map((item) => ({ item, more: 0 })),
        ]
    rowsOf.set(card.key, rows)
    card.h = rows.length * ROW_HEIGHT + CARD_PAD * 2
  }

  // 3. y: top-down; x: leaf slots in DFS order, parents centred (iterative).
  const root = order[0]
  if (root) {
    const down: Card[] = [root]
    for (let c = down.pop(); c; c = down.pop()) {
      for (const childKey of c.children) {
        const child = cards.get(childKey)
        if (!child) continue
        child.y = c.y + c.h + CARD_GAP
        down.push(child)
      }
    }
    let slot = 0
    const post: { card: Card; seen: boolean }[] = [{ card: root, seen: false }]
    for (let top = post.at(-1); top; top = post.at(-1)) {
      if (!top.seen) {
        top.seen = true
        for (let i = top.card.children.length - 1; i >= 0; i--) {
          const child = cards.get(top.card.children[i] ?? '')
          if (child) post.push({ card: child, seen: false })
        }
        continue
      }
      post.pop()
      const kids = top.card.children.map((k) => cards.get(k)).filter((c): c is Card => !!c)
      const first = kids[0]
      const last = kids.at(-1)
      if (first && last) top.card.x = (first.x + last.x) / 2
      else top.card.x = slot++ * CARD_SLOT
    }
  }

  // 4. Boxes, item positions, edges.
  const boxes: Box[] = []
  const pos = new Map<string, Rect>()
  const boxOf = new Map<string, string>()
  for (const card of order) {
    const rows: CardRow[] = (rowsOf.get(card.key) ?? []).map((r, i) => ({
      ...r,
      y: card.y + CARD_PAD + i * ROW_HEIGHT + ROW_HEIGHT / 2,
    }))
    const box: Box = {
      key: card.key,
      kind: 'card',
      x: card.x,
      y: card.y,
      w: CARD_WIDTH,
      h: card.h,
      items: card.items,
      rows,
      open: openOf.get(card.key) ?? true,
      long: card.items.length > LONG_CARD,
    }
    boxes.push(box)
    const moreRow = rows.find((r) => !r.item)
    const rowOf = new Map<string, CardRow>()
    for (const r of rows) if (r.item) rowOf.set(r.item.key, r)
    for (const item of card.items) {
      boxOf.set(item.key, card.key)
      const row = rowOf.get(item.key) ?? moreRow
      pos.set(item.key, { x: card.x, y: row?.y ?? card.y, w: CARD_WIDTH, h: ROW_HEIGHT })
    }
  }
  const edges: Edge[] = []
  for (const card of order) {
    for (const childKey of card.children) {
      const child = cards.get(childKey)
      const first = child?.items[0]
      if (!child || !first) continue
      edges.push({
        key: child.key,
        x1: card.x,
        y1: card.y + card.h,
        x2: child.x,
        y2: child.y - EDGE_GAP,
        dim: first.underDead || first.cross,
      })
    }
  }
  return { mode: 'compact', boxes, edges, pos, boxOf, bounds: boundsOf(boxes) }
}
