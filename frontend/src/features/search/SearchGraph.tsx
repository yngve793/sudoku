import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import type { SearchTree } from '../../api/types'
import {
  CARD_WIDTH,
  ROW_HEIGHT,
  compactModel,
  expandedModel,
  type Box,
  type CardRow,
  type Rect,
} from './graphLayout'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  buildGraph,
  type GraphItem,
  type TechniqueMap,
} from './graphModel'
import { useGraphLayoutPref } from './graphPrefs'

interface SearchGraphProps {
  tree: SearchTree
  /** Key of the selected graph item (see graphModel `itemKey`). */
  selectedKey: string
  techniques?: TechniqueMap
  onSelectItem: (item: GraphItem) => void
  onToggleCollapse: (nodeId: string) => void
  /** Taller drawing area (full-screen tree page). */
  tall?: boolean
}

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

const PAD = 24
/** Largest area shown automatically; bigger graphs follow the selection. */
const AUTO_MAX_W = 760
const AUTO_MAX_H = 460
/** Auto view at most this many SVG units per screen pixel (keeps labels legible). */
const AUTO_MAX_UNITS_PER_PX = 1.15
/** Above this many units per pixel labels are unreadable: draw boxes only. */
const DETAIL_UNITS_PER_PX = 2.6
const MIN_W = 160
const MAX_W = 400_000
/** Extra margin rendered around the view so panning is smooth (SVG units). */
const OVERSCAN = 120

function padded(b: { minX: number; minY: number; maxX: number; maxY: number }): ViewBox {
  return {
    x: b.minX - PAD,
    y: b.minY - PAD,
    w: b.maxX - b.minX + PAD * 2,
    h: b.maxY - b.minY + PAD * 2,
  }
}

/** Whole graph when it is small, otherwise a window centred on `focus`. */
function autoView(full: ViewBox, focus: Rect | undefined, px: { w: number; h: number }): ViewBox {
  const maxW = px.w > 0 ? Math.min(AUTO_MAX_W, px.w * AUTO_MAX_UNITS_PER_PX) : AUTO_MAX_W
  const maxH = px.h > 0 ? Math.min(AUTO_MAX_H, px.h * AUTO_MAX_UNITS_PER_PX) : AUTO_MAX_H
  const w = Math.min(full.w, maxW)
  const h = Math.min(full.h, maxH)
  if (w === full.w && h === full.h) return full
  const cx = focus?.x ?? full.x + full.w / 2
  const cy = focus?.y ?? full.y + h / 2
  const x = Math.min(Math.max(cx - w / 2, full.x), full.x + full.w - w)
  const y = Math.min(Math.max(cy - h / 2, full.y), full.y + full.h - h)
  return { x, y, w, h }
}

const overlaps = (view: ViewBox, x1: number, y1: number, x2: number, y2: number, m = 0) =>
  x2 >= view.x - m && x1 <= view.x + view.w + m && y2 >= view.y - m && y1 <= view.y + view.h + m

const rectInView = (view: ViewBox, r: Rect, m = 0) =>
  overlaps(view, r.x - r.w / 2, r.y - r.h / 2, r.x + r.w / 2, r.y + r.h / 2, m)

function zoomed(view: ViewBox, factor: number, cx = view.x + view.w / 2, cy = view.y + view.h / 2) {
  const w = Math.min(Math.max(view.w * factor, MIN_W), MAX_W)
  const k = w / view.w
  return { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, w, h: view.h * k }
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`
  const mid = (y1 + y2) / 2
  return `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`
}

function toSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const ctm = svg.getScreenCTM()
  if (!ctm || typeof DOMPoint === 'undefined') return null
  return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
}

/**
 * The search tree as an accessible, pannable, zoomable SVG graph. Every guess
 * and inferred value has its own `treeitem`: a box (Expanded) or a row in a
 * chain card (Compact, the default). Only what is near the view is rendered.
 * Keyboard: ↑ parent, ↓ first child, ←/→ siblings, Home root, Enter selects,
 * Space collapses/expands.
 */
export function SearchGraph({
  tree,
  selectedKey,
  techniques,
  onSelectItem,
  onToggleCollapse,
  tall = false,
}: SearchGraphProps) {
  const graph = useMemo(() => buildGraph(tree, techniques), [tree, techniques])
  const [layout, setLayout] = useGraphLayoutPref()
  const markerId = `arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const svgRef = useRef<SVGSVGElement>(null)
  const itemRefs = useRef(new Map<string, SVGGElement>())
  const registerItem = useCallback((key: string, el: SVGGElement | null) => {
    if (el) itemRefs.current.set(key, el)
    else itemRefs.current.delete(key)
  }, [])
  const [focusKey, setFocusKey] = useState<string | null>(null)
  // Item reached with the arrow keys, tied to the selection it started from: the
  // automatic view follows it, and goes back to following the selection after.
  const [navKey, setNavKey] = useState<{ key: string; from: string | undefined } | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const [manualView, setManualView] = useState<ViewBox | null>(null)
  const [px, setPx] = useState({ w: 0, h: 0 })
  const [openCards, setOpenCards] = useState<ReadonlySet<string>>(() => new Set())
  const drag = useRef<{ x: number; y: number; view: ViewBox; moved: boolean } | null>(null)

  const rootKey = graph.items[0]?.key
  const selKey = graph.byKey.has(selectedKey) ? selectedKey : rootKey
  const activeKey = focusKey !== null && graph.byKey.has(focusKey) ? focusKey : selKey
  const followKey = navKey && navKey.from === selKey ? navKey.key : selKey

  const model = useMemo(
    () =>
      layout === 'compact'
        ? compactModel(graph, openCards, [selKey, activeKey, followKey])
        : expandedModel(graph),
    [layout, graph, openCards, selKey, activeKey, followKey],
  )
  const full = padded(model.bounds)
  const view = manualView ?? autoView(full, model.pos.get(followKey ?? ''), px)
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  })
  const unitsPerPx = px.w > 0 ? view.w / px.w : 1
  const detailed = unitsPerPx <= DETAIL_UNITS_PER_PX

  // Windowing: boxes, rows and edges near the view; pinned items always.
  const { boxes, edges } = useMemo(() => {
    const pinned = new Set([selKey, activeKey, followKey])
    const shown = model.boxes.filter(
      (b) =>
        overlaps(view, b.x - b.w / 2, b.y, b.x + b.w / 2, b.y + b.h, OVERSCAN) ||
        b.items.some((i) => pinned.has(i.key)),
    )
    const lines = model.edges.filter(
      (e) =>
        overlaps(view, Math.min(e.x1, e.x2), e.y1, Math.max(e.x1, e.x2), e.y2, OVERSCAN) ||
        overlaps(view, e.x1, e.y1, e.x1, e.y1, OVERSCAN),
    )
    return { boxes: shown, edges: lines }
  }, [model, view, selKey, activeKey, followKey])
  const rowVisible = useCallback(
    (row: CardRow) =>
      overlaps(view, -Infinity, row.y - ROW_HEIGHT, Infinity, row.y + ROW_HEIGHT, OVERSCAN) ||
      (row.item !== null &&
        (row.item.key === selKey || row.item.key === activeKey || row.item.key === followKey)),
    [view, selKey, activeKey, followKey],
  )

  // Track the rendered size so the automatic view stays legible on phones.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setPx({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) })
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = toSvgPoint(svg, event.clientX, event.clientY)
      setManualView(zoomed(viewRef.current, event.deltaY > 0 ? 1.15 : 1 / 1.15, point?.x, point?.y))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  function moveFocus(key: string | undefined) {
    if (!key) return
    setFocusKey(key)
    setNavKey({ key, from: selKey })
    const at = model.pos.get(key)
    if (manualView && at && !rectInView(manualView, at)) {
      setManualView({ ...manualView, x: at.x - manualView.w / 2, y: at.y - manualView.h / 2 })
    }
    pendingFocus.current = key
  }

  // Move DOM focus after render, once the roving tabindex is on the new item.
  useEffect(() => {
    const key = pendingFocus.current
    if (key === null) return
    pendingFocus.current = null
    itemRefs.current.get(key)?.focus()
  })

  function onItemKeyDown(event: KeyboardEvent<SVGGElement>, item: GraphItem) {
    const parent = item.parentKey ? graph.byKey.get(item.parentKey) : undefined
    const siblings = parent ? parent.children : [item.key]
    const index = siblings.indexOf(item.key)
    let handled = true
    switch (event.key) {
      case 'ArrowUp':
        moveFocus(parent?.key)
        break
      case 'ArrowDown':
        moveFocus(item.children[0])
        break
      case 'ArrowLeft':
        moveFocus(siblings[index - 1])
        break
      case 'ArrowRight':
        moveFocus(siblings[index + 1])
        break
      case 'Home':
        moveFocus(rootKey)
        break
      case 'Enter':
        onSelectItem(item)
        break
      case ' ': {
        const guess = graph.byKey.get(item.nodeId)
        if (guess?.collapsible) {
          onToggleCollapse(item.nodeId)
          moveFocus(guess.key)
        }
        break
      }
      default:
        handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, view, moved: false }
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const start = drag.current
    const svg = svgRef.current
    if (!start || !svg) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (!start.moved && Math.hypot(dx, dy) < 4) return
    if (!start.moved && typeof svg.setPointerCapture === 'function')
      svg.setPointerCapture(event.pointerId)
    start.moved = true
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const scale = Math.max(start.view.w / rect.width, start.view.h / rect.height)
    setManualView({ ...start.view, x: start.view.x - dx * scale, y: start.view.y - dy * scale })
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current
    if (typeof svg?.hasPointerCapture === 'function' && svg.hasPointerCapture(event.pointerId))
      svg.releasePointerCapture(event.pointerId)
    // A drag must not also count as a click on the node under the pointer.
    if (drag.current?.moved) {
      const stop = (e: MouseEvent) => {
        e.stopPropagation()
        window.removeEventListener('click', stop, true)
      }
      window.addEventListener('click', stop, true)
      setTimeout(() => window.removeEventListener('click', stop, true), 0)
    }
    drag.current = null
  }

  const openCard = useCallback((key: string) => setOpenCards((prev) => new Set(prev).add(key)), [])

  const total = graph.items.length
  const common = {
    selKey,
    activeKey,
    detailed,
    registerItem,
    onFocusItem: setFocusKey,
    onSelectItem,
    onToggle: onToggleCollapse,
    onKeyDown: onItemKeyDown,
  }
  return (
    <div className="search-graph">
      <div className="search-graph__tools" role="toolbar" aria-label="Graph view">
        <fieldset className="segmented search-graph__layout">
          <legend className="visually-hidden">Graph layout</legend>
          {(['compact', 'expanded'] as const).map((mode) => (
            <label key={mode} className="segmented__option">
              <input
                type="radio"
                name={`${markerId}-layout`}
                value={mode}
                checked={layout === mode}
                onChange={() => {
                  setLayout(mode)
                  setManualView(null)
                }}
              />
              <span>{mode === 'compact' ? 'Compact' : 'Expanded'}</span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom in"
          onClick={() => setManualView(zoomed(view, 1 / 1.3))}
        >
          +
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom out"
          onClick={() => setManualView(zoomed(view, 1.3))}
        >
          −
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => setManualView(full)}
        >
          Fit
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => setManualView(null)}
          disabled={manualView === null}
        >
          Follow selection
        </button>
        <span className="search-graph__count">
          {tree.nodes.length} {tree.nodes.length === 1 ? 'branch' : 'branches'} · {total}{' '}
          {total === 1 ? 'node' : 'nodes'}
        </span>
      </div>
      <svg
        ref={svgRef}
        className={`search-graph__svg${tall ? ' search-graph__svg--tall' : ''}${detailed ? '' : ' search-graph__svg--overview'}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" className="search-graph__arrow" />
          </marker>
        </defs>
        <g aria-hidden="true">
          {edges.map((e) => (
            <path
              key={e.key}
              d={edgePath(e.x1, e.y1, e.x2, e.y2)}
              className={`search-graph__edge${e.dim ? ' search-graph__edge--dead' : ''}`}
              markerEnd={`url(#${markerId})`}
            />
          ))}
        </g>
        {model.mode === 'compact' &&
          boxes.map((box) => (
            <CardFrame key={box.key} box={box} rowVisible={rowVisible} onOpen={openCard} />
          ))}
        <g role="tree" aria-label="Search tree" aria-multiselectable="false">
          {model.mode === 'expanded'
            ? boxes.map((box) =>
                box.items.map((item) => <GraphNode key={item.key} item={item} {...common} />),
              )
            : boxes.map((box) =>
                box.rows.map((row) =>
                  row.item && rowVisible(row) ? (
                    <CardRowNode
                      key={row.item.key}
                      item={row.item}
                      box={box}
                      y={row.y}
                      {...common}
                    />
                  ) : null,
                ),
              )}
        </g>
      </svg>
      <ul className="search-legend" aria-label="Legend">
        <li>
          <span className="search-legend__swatch search-legend__swatch--guess" aria-hidden="true" />
          guess
        </li>
        <li>
          <span
            className="search-legend__swatch search-legend__swatch--manual"
            aria-hidden="true"
          />
          placed
        </li>
        <li>
          <span className="search-legend__swatch search-legend__swatch--auto" aria-hidden="true" />
          <i>implied (auto)</i>
        </li>
        <li>
          <span className="search-legend__mark search-legend__mark--dead" aria-hidden="true">
            ✗
          </span>
          contradiction
        </li>
        <li>
          <span className="search-legend__mark search-legend__mark--solved" aria-hidden="true">
            ✓
          </span>
          solved
        </li>
      </ul>
      <p className="search-graph__help">
        <kbd>↑↓</kbd> step by step · <kbd>←→</kbd> siblings · <kbd>Enter</kbd> select ·{' '}
        <kbd>Space</kbd> collapse · drag to pan, scroll to zoom
      </p>
    </div>
  )
}

interface NodeProps {
  item: GraphItem
  selKey: string | undefined
  activeKey: string | undefined
  detailed: boolean
  registerItem: (key: string, el: SVGGElement | null) => void
  onFocusItem: (key: string) => void
  onSelectItem: (item: GraphItem) => void
  onToggle: (nodeId: string) => void
  onKeyDown: (event: KeyboardEvent<SVGGElement>, item: GraphItem) => void
}

function itemClass(base: string, item: GraphItem, selected: boolean): string {
  return [
    base,
    `graph-node--${item.kind}`,
    selected && 'graph-node--selected',
    item.cross && 'graph-node--dead',
    item.solved && 'graph-node--solved',
    item.underDead && 'graph-node--under-dead',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Shared treeitem attributes. */
function treeItemProps(p: NodeProps) {
  const { item } = p
  const selected = item.key === p.selKey
  return {
    ref: (el: SVGGElement | null) => p.registerItem(item.key, el),
    role: 'treeitem',
    tabIndex: item.key === p.activeKey ? 0 : -1,
    'aria-label': item.ariaLabel,
    'aria-selected': selected,
    'aria-expanded': item.collapsible ? !item.collapsed : undefined,
    'aria-level': item.depth + 1,
    'aria-posinset': item.posInSet,
    'aria-setsize': item.setSize,
    'data-key': item.key,
    'data-kind': item.kind,
    onClick: () => p.onSelectItem(item),
    onFocus: () => p.onFocusItem(item.key),
    onKeyDown: (event: KeyboardEvent<SVGGElement>) => p.onKeyDown(event, item),
  } as const
}

function Toggle({
  item,
  x,
  y,
  onToggle,
}: {
  item: GraphItem
  x: number
  y: number
  onToggle: (id: string) => void
}) {
  if (!item.collapsible) return null
  // Mouse affordance only; keyboard users press Space on the item.
  return (
    <g
      className="graph-node__toggle"
      transform={`translate(${x},${y})`}
      onClick={(event) => {
        event.stopPropagation()
        onToggle(item.nodeId)
      }}
    >
      <circle r={8} />
      <text textAnchor="middle" dy="0.35em">
        {item.collapsed ? '+' : '−'}
      </text>
    </g>
  )
}

const GraphNode = memo(function GraphNode(p: NodeProps) {
  const { item } = p
  const hw = NODE_WIDTH / 2
  const hh = NODE_HEIGHT / 2
  return (
    <g
      {...treeItemProps(p)}
      className={itemClass('graph-node', item, item.key === p.selKey)}
      transform={`translate(${item.x},${item.y})`}
    >
      <title>{item.title}</title>
      <rect
        className="graph-node__box"
        x={-hw}
        y={-hh}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={7}
      />
      {item.kind === 'guess' && (
        <rect
          className="graph-node__inner"
          x={-hw + 3}
          y={-hh + 3}
          width={NODE_WIDTH - 6}
          height={NODE_HEIGHT - 6}
          rx={5}
        />
      )}
      {item.cross && (
        <path
          className="graph-node__cross"
          d={`M${-hw + 6},${-hh + 4} L${hw - 6},${hh - 4} M${hw - 6},${-hh + 4} L${-hw + 6},${hh - 4}`}
        />
      )}
      {p.detailed && (
        <text className="graph-node__label" textAnchor="middle" dy="0.35em">
          {item.label}
        </text>
      )}
      {item.solved && (
        <text className="graph-node__check" x={-hw + 2} y={-hh + 2} textAnchor="middle">
          ✓
        </text>
      )}
      <Toggle item={item} x={hw + 11} y={0} onToggle={p.onToggle} />
      {item.collapsed && (
        <g className="graph-node__summary" transform={`translate(0,${hh + 14})`}>
          <rect x={-20} y={-9} width={40} height={18} rx={9} />
          <text textAnchor="middle" dy="0.35em">
            +{item.hiddenCount}
          </text>
        </g>
      )}
    </g>
  )
})

/** The card's frame and its "… n more" row (not tree items). */
function CardFrame({
  box,
  rowVisible,
  onOpen,
}: {
  box: Box
  rowVisible: (row: CardRow) => boolean
  onOpen: (key: string) => void
}) {
  const dead = box.items.some((i) => i.cross)
  return (
    <g className={`chain-card${dead ? ' chain-card--dead' : ''}`}>
      <rect
        className="chain-card__frame"
        x={box.x - box.w / 2}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={8}
      />
      {box.rows.map((row) =>
        row.item || !rowVisible(row) ? null : (
          <g
            key="more"
            role="button"
            tabIndex={-1}
            className="chain-card__more"
            aria-label={`Show ${row.more} more steps`}
            transform={`translate(${box.x},${row.y})`}
            onClick={() => onOpen(box.key)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onOpen(box.key)
            }}
          >
            <rect
              x={-box.w / 2 + 4}
              y={-ROW_HEIGHT / 2 + 2}
              width={box.w - 8}
              height={ROW_HEIGHT - 4}
              rx={4}
            />
            <text textAnchor="middle" dy="0.35em">
              … {row.more} more
            </text>
          </g>
        ),
      )}
    </g>
  )
}

const CardRowNode = memo(function CardRowNode(p: NodeProps & { box: Box; y: number }) {
  const { item, box } = p
  const left = -CARD_WIDTH / 2
  return (
    <g
      {...treeItemProps(p)}
      className={itemClass('graph-row', item, item.key === p.selKey)}
      transform={`translate(${box.x},${p.y})`}
    >
      <title>{item.title}</title>
      <rect
        className="graph-row__hit"
        x={left + 3}
        y={-ROW_HEIGHT / 2 + 1}
        width={CARD_WIDTH - 6}
        height={ROW_HEIGHT - 2}
        rx={4}
      />
      <line className="graph-row__bar" x1={left + 7} x2={left + 7} y1={-7} y2={7} />
      {(item.kind === 'guess' || item.kind === 'root') && (
        <>
          <line
            className="graph-row__rule"
            x1={left + 6}
            x2={-left - 6}
            y1={ROW_HEIGHT / 2 - 3}
            y2={ROW_HEIGHT / 2 - 3}
          />
          <line
            className="graph-row__rule"
            x1={left + 6}
            x2={-left - 6}
            y1={ROW_HEIGHT / 2 - 1}
            y2={ROW_HEIGHT / 2 - 1}
          />
        </>
      )}
      {p.detailed && (
        <text className="graph-node__label graph-row__label" x={left + 16} dy="0.35em">
          {item.label}
        </text>
      )}
      {item.cross && (
        <path className="graph-node__cross graph-row__cross" d="M28,-5 L38,5 M38,-5 L28,5" />
      )}
      {item.solved && (
        <text className="graph-node__check graph-row__check" x={33} dy="0.35em" textAnchor="middle">
          ✓
        </text>
      )}
      <Toggle item={item} x={-left - 11} y={0} onToggle={p.onToggle} />
      {item.collapsed && (
        <text className="graph-node__summary graph-row__summary" x={-left + 4} dy="0.35em">
          +{item.hiddenCount}
        </text>
      )}
    </g>
  )
})
