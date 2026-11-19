import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useReducer, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchTree } from '../../api/types'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  buildGraph,
  itemKey,
  selectedItemKey,
  techniqueKey,
  type TechniqueMap,
} from './graphModel'
import { CARD_EDGE_ROWS, compactModel } from './graphLayout'
import { GRAPH_LAYOUT_KEY } from './graphPrefs'
import { bigTree } from '../../test/searchTrees'
import { SearchGraph } from './SearchGraph'
import {
  ROOT_ID,
  createSearchState,
  findNode,
  searchReducer,
  type SearchAction,
} from './searchReducer'

const SOLVED = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'
const TRAP = '004000012002090300190000507800000020426800001700920054061050080200000635340080070'
const EMPTY = '0'.repeat(81)
const sol = (i: number) => Number(SOLVED[i])

function build(board: string, ...actions: SearchAction[]): SearchTree {
  const s = [{ type: 'create', rootBoard: board } as SearchAction, ...actions].reduce(
    searchReducer,
    createSearchState(),
  )
  if (!s.tree) throw new Error('no tree')
  return s.tree
}

/** Guess r1c1 (correct value) and place `n` more correct digits manually. */
function chain(n: number, ...more: SearchAction[]): SearchTree {
  const actions: SearchAction[] = [{ type: 'guess', cell: 0, value: sol(0) }]
  for (let c = 1; c <= n; c++) actions.push({ type: 'place', cell: c, value: sol(c) })
  return build(EMPTY, ...actions, ...more)
}

/** Stateful harness: the graph drives the real reducer plus UI step selection. */
function Harness({ initial, techniques }: { initial: SearchTree; techniques?: TechniqueMap }) {
  const [state, dispatch] = useReducer(searchReducer, initial, (tree) =>
    searchReducer(createSearchState(), { type: 'load', tree }),
  )
  const [step, setStep] = useState<{ nodeId: string; step: number } | null>(null)
  if (!state.tree) return null
  const node = findNode(state.tree, state.tree.selected_node_id)!
  const viewStep = step?.nodeId === node.id ? step.step : null
  return (
    <>
      <output data-testid="selection">{`${node.id}@${viewStep ?? 'end'}`}</output>
      <SearchGraph
        tree={state.tree}
        selectedKey={selectedItemKey(node, viewStep)}
        techniques={techniques}
        onSelectItem={(item) => {
          dispatch({ type: 'select', nodeId: item.nodeId })
          setStep(item.chainEnd ? null : { nodeId: item.nodeId, step: item.step })
        }}
        onToggleCollapse={(nodeId) => {
          setStep(null)
          dispatch({ type: 'collapse', nodeId })
        }}
      />
    </>
  )
}

const item = (name: string | RegExp) => screen.getByRole('treeitem', { name })

describe('buildGraph', () => {
  it('draws each placement as its own node, chained in order under the guess', () => {
    const tree = chain(3)
    const g = buildGraph(tree)
    expect(g.items.map((i) => i.label)).toEqual(['Start', 'r1c1=5', 'r1c2=3', 'r1c3=4', 'r1c4=6'])
    expect(g.items.map((i) => i.kind)).toEqual(['root', 'guess', 'manual', 'manual', 'manual'])
    const [, guess, p0, p1, p2] = g.items
    expect(p0!.parentKey).toBe(guess!.key)
    expect(p1!.parentKey).toBe(p0!.key)
    expect(p2!.key).toBe(itemKey('n2', 2))
    expect(p2!.chainEnd).toBe(true)
    expect(guess!.chainEnd).toBe(false)
    expect(g.chainEndOf.get('n2')).toBe(p2!.key)
    expect(p0!.ariaLabel).toBe('r1c2 equals 3, placed manually, step 1 of 3 after r1c1 equals 5.')
    // Straight down the chain.
    expect(new Set(g.items.slice(1).map((i) => i.x)).size).toBe(1)
    expect(p0!.y).toBeGreaterThan(guess!.y)
  })

  it('hangs child guesses and branches off the last node of the chain', () => {
    const tree = chain(2, { type: 'branch', cell: 9 })
    const g = buildGraph(tree)
    const end = g.byKey.get(itemKey('n2', 1))!
    expect(end.children).toHaveLength(6) // r2c1 after r1c1..r1c3 = 5 3 4
    for (const key of end.children) {
      expect(g.byKey.get(key)?.kind).toBe('guess')
      expect(g.byKey.get(key)?.parentKey).toBe(end.key)
    }
    // Siblings at the branch point never overlap.
    const xs = end.children.map((k) => g.byKey.get(k)!.x).sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(NODE_WIDTH)
    expect(g.bounds.maxY - g.bounds.minY).toBeGreaterThan(NODE_HEIGHT)
  })

  it('labels auto placements with the technique when known, else "auto"', () => {
    const tree = build(EMPTY, { type: 'guess', cell: 0, value: 5 })
    const withAuto = searchReducer(searchReducer(createSearchState(), { type: 'load', tree }), {
      type: 'autoResult',
      nodeId: 'n2',
      placements: [
        { cell: 1, value: 3 },
        { cell: 2, value: 4 },
      ],
      contradiction: null,
    }).tree!
    const techniques = new Map([[techniqueKey('n2', 1, 3), 'Naked Single']])
    const g = buildGraph(withAuto, techniques)
    const [a, b] = [g.byKey.get(itemKey('n2', 0))!, g.byKey.get(itemKey('n2', 1))!]
    expect(a.kind).toBe('auto')
    expect(a.ariaLabel).toBe(
      'r1c2 equals 3, implied by Naked Single, step 1 of 2 after r1c1 equals 5.',
    )
    expect(a.title).toBe('r1c2=3 · Naked Single')
    expect(b.ariaLabel).toBe('r1c3 equals 4, implied (auto), step 2 of 2 after r1c1 equals 5.')
    expect(b.title).toBe('r1c3=4 · auto')
  })

  it('puts the ✗ on the guess when the guess itself contradicts', () => {
    const g = buildGraph(build(TRAP, { type: 'guess', cell: 35, value: 3 }))
    const guess = g.byKey.get('n2')!
    expect(guess.cross).toBe(true)
    expect(guess.ariaLabel).toMatch(/^r4c9 equals 3, dead: /)
  })

  it('puts the ✗ on the placement that caused the contradiction and dims what follows', () => {
    // Guess r1c1=5, place r1c2=3 (fine), then r2c1=5 (duplicate in column 1 / box 1).
    const tree = build(
      EMPTY,
      { type: 'guess', cell: 0, value: 5 },
      { type: 'place', cell: 1, value: 3 },
      { type: 'place', cell: 9, value: 5 },
      { type: 'place', cell: 40, value: 1 },
    )
    const g = buildGraph(tree)
    expect(g.byKey.get('n2')!.cross).toBe(false)
    expect(g.byKey.get(itemKey('n2', 0))!.cross).toBe(false)
    const bad = g.byKey.get(itemKey('n2', 1))!
    expect(bad.cross).toBe(true)
    expect(bad.ariaLabel).toBe(
      'r2c1 equals 5, placed manually, step 2 of 3 after r1c1 equals 5, contradiction: 5 appears twice in column 1 (r1c1, r2c1).',
    )
    expect(g.byKey.get(itemKey('n2', 2))!.underDead).toBe(true)
    expect(g.byKey.get(itemKey('n2', 0))!.underDead).toBe(false)
  })

  it('puts the ✗ of a branch-dead node on the end of its chain; ✓ on a solved chain end', () => {
    const dead = buildGraph(build(TRAP, { type: 'branch', cell: 35 }))
    expect(dead.byKey.get(ROOT_ID)!.cross).toBe(true)
    const solvedBoard = `${SOLVED.slice(0, 79)}00`
    const g = buildGraph(
      build(
        solvedBoard,
        { type: 'guess', cell: 79, value: 7 },
        { type: 'place', cell: 80, value: 9 },
      ),
    )
    expect(g.byKey.get('n2')!.solved).toBe(false)
    const end = g.byKey.get(itemKey('n2', 0))!
    expect(end.solved).toBe(true)
    expect(end.ariaLabel).toMatch(/, board solved\.$/)
  })

  it('folds a collapsed guess (chain and subtree) into a +n summary', () => {
    const tree = chain(
      3,
      { type: 'guess', cell: 20, value: sol(20) },
      { type: 'collapse', nodeId: 'n2' },
    )
    const g = buildGraph(tree)
    expect(g.items.map((i) => i.key)).toEqual([ROOT_ID, 'n2'])
    const guess = g.byKey.get('n2')!
    expect(guess.collapsed).toBe(true)
    expect(guess.hiddenCount).toBe(4) // 3 placements + 1 child guess
    expect(guess.chainEnd).toBe(true)
    expect(guess.ariaLabel).toMatch(/Collapsed, 4 hidden nodes\.$/)
    expect(selectedItemKey(findNode(tree, 'n2')!, null)).toBe('n2')
  })

  it('a node with only placements is collapsible', () => {
    const tree = chain(2)
    expect(buildGraph(tree).byKey.get('n2')!.collapsible).toBe(true)
    const folded = searchReducer(searchReducer(createSearchState(), { type: 'load', tree }), {
      type: 'collapse',
      nodeId: 'n2',
    }).tree!
    expect(findNode(folded, 'n2')!.collapsed).toBe(true)
  })
})

const useExpanded = () => {
  beforeEach(() => localStorage.setItem(GRAPH_LAYOUT_KEY, 'expanded'))
  afterEach(() => localStorage.removeItem(GRAPH_LAYOUT_KEY))
}

describe('scale', () => {
  useExpanded()

  // Timing thresholds live in SearchGraph.perf.test.tsx (`npm run test:perf`);
  // the default run only checks behaviour, so CPU load cannot make it flaky.
  it('builds a ~2,000-node graph', () => {
    expect(buildGraph(bigTree()).items).toHaveLength(1 + 25 * 81)
  })

  it(
    'renders only the visible window, and Fit draws everything without labels',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup()
      const tree = bigTree()
      render(<Harness initial={tree} />)
      const windowed = screen.getAllByRole('treeitem').length
      expect(windowed).toBeLessThan(400)
      expect(windowed).toBeGreaterThan(10)
      // The selection (end of b12's chain) is rendered and selected.
      expect(document.querySelector('[data-key="b12#79"]')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText('26 branches · 2026 nodes')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Fit' }))
      expect(screen.getAllByRole('treeitem')).toHaveLength(2026)
    },
  )
})

describe('SearchGraph (expanded)', () => {
  useExpanded()

  it('renders kinds, ✗ and arrows accessibly', () => {
    const tree = build(TRAP, { type: 'branch', cell: 35 })
    render(<Harness initial={tree} />)
    const svgTree = screen.getByRole('tree', { name: 'Search tree' })
    expect(within(svgTree).getAllByRole('treeitem')).toHaveLength(4)
    const root = item(/^Start position/)
    expect(root).toHaveAttribute('aria-selected', 'true')
    expect(root).toHaveAttribute('aria-expanded', 'true')
    expect(root).toHaveAccessibleName('Start position, dead: every option for r4c9 fails.')
    const three = item(/^r4c9 equals 3, dead: /)
    expect(three).toHaveAttribute('data-kind', 'guess')
    expect(three).toHaveAttribute('aria-level', '2')
    expect(three).toHaveAttribute('aria-setsize', '3')
    expect(three.querySelector('.graph-node__inner')).not.toBeNull() // double border
    expect(three.querySelector('.graph-node__cross')).not.toBeNull()
    expect(within(three).getByText('r4c9=3', { selector: 'text' })).toBeInTheDocument()
    const edges = document.querySelectorAll('.search-graph__edge')
    expect(edges).toHaveLength(3)
    expect(edges[0]?.getAttribute('marker-end')).toMatch(/^url\(#arrow-/)
  })

  it('auto placements are dashed/italic nodes with a technique tooltip', () => {
    const base = build(EMPTY, { type: 'guess', cell: 0, value: 5 })
    const tree = searchReducer(searchReducer(createSearchState(), { type: 'load', tree: base }), {
      type: 'autoResult',
      nodeId: 'n2',
      placements: [{ cell: 1, value: 3 }],
      contradiction: null,
    }).tree!
    render(
      <Harness
        initial={tree}
        techniques={new Map([[techniqueKey('n2', 1, 3), 'Hidden Single']])}
      />,
    )
    const auto = item(/^r1c2 equals 3, implied by Hidden Single/)
    expect(auto).toHaveAttribute('data-kind', 'auto')
    expect(auto.querySelector('title')).toHaveTextContent('r1c2=3 · Hidden Single')
    expect(screen.queryByText('+1')).toBeNull() // no more implication badge
  })

  it('selecting an implication selects that step; collapse folds into +n', async () => {
    const user = userEvent.setup()
    render(<Harness initial={chain(3)} />)
    // The selection is the end of the chain.
    expect(item(/^r1c4 equals 6/)).toHaveAttribute('aria-selected', 'true')
    await user.click(item(/^r1c2 equals 3/))
    expect(item(/^r1c2 equals 3/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('selection')).toHaveTextContent('n2@0')
    await user.click(item(/^r1c1 equals 5/))
    expect(screen.getByTestId('selection')).toHaveTextContent('n2@-1')
    await user.click(item(/^r1c4 equals 6/))
    expect(screen.getByTestId('selection')).toHaveTextContent('n2@end')

    fireEvent.click(item(/^r1c1 equals 5/).querySelector('.graph-node__toggle')!)
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    expect(item(/^r1c1 equals 5/)).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('+3')).toBeInTheDocument()
    expect(item(/^r1c1 equals 5/)).toHaveAttribute('aria-selected', 'true')
  })

  it('keyboard: ↓/↑ walk the chain, ←/→ move between siblings, Enter selects, Space folds', async () => {
    const user = userEvent.setup()
    // Start → r1c1=5 → r1c2=3 → r1c3=4, with two guesses hanging off r1c3=4.
    const tree = chain(
      2,
      { type: 'guess', cell: 9, value: 6 },
      { type: 'select', nodeId: 'n2' },
      { type: 'guess', cell: 9, value: 2 },
      { type: 'select', nodeId: ROOT_ID },
    )
    render(<Harness initial={tree} />)
    const root = item(/^Start position/)
    expect(root).toHaveAttribute('tabindex', '0')
    act(() => root.focus())
    await user.keyboard('{ArrowDown}')
    expect(item(/^r1c1 equals 5/)).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(item(/^r1c2 equals 3/)).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(item(/^r2c1 equals 6/)).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(item(/^r2c1 equals 2/)).toHaveFocus()
    await user.keyboard('{ArrowRight}') // no further sibling
    expect(item(/^r2c1 equals 2/)).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowUp}')
    expect(item(/^r1c3 equals 4/)).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(item(/^r1c3 equals 4/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('selection')).toHaveTextContent('n2@end')
    await user.keyboard(' ') // folds the owning guess; focus moves to it
    expect(item(/^r1c1 equals 5/)).toHaveAttribute('aria-expanded', 'false')
    expect(item(/^r1c1 equals 5/)).toHaveFocus()
    await user.keyboard(' ')
    expect(item(/^r1c1 equals 5/)).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Home}')
    expect(item(/^Start/)).toHaveFocus()
  })

  it('zooms, fits and follows the selection via the toolbar', async () => {
    const user = userEvent.setup()
    render(<Harness initial={build(EMPTY, { type: 'branch', cell: 0 })} />)
    const svg = document.querySelector('svg.search-graph__svg')!
    const initial = svg.getAttribute('viewBox')
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    const zoomed = svg.getAttribute('viewBox')!
    expect(Number(zoomed.split(' ')[2])).toBeLessThan(Number(initial!.split(' ')[2]))
    await user.click(screen.getByRole('button', { name: 'Zoom out' }))
    await user.click(screen.getByRole('button', { name: 'Fit' }))
    await user.click(screen.getByRole('button', { name: 'Follow selection' }))
    expect(svg.getAttribute('viewBox')).toBe(initial)
    expect(screen.getByText('10 branches · 10 nodes')).toBeInTheDocument()
  })
})

describe('compactModel', () => {
  const keys = (m: ReturnType<typeof compactModel>) => m.boxes.map((b) => b.items.map((i) => i.key))

  it('merges every run of unique-child nodes into one card; branch points end it', () => {
    const g = buildGraph(chain(2, { type: 'branch', cell: 9 }))
    const m = compactModel(g)
    // Start → r1c1=5 → r1c2 → r1c3 is one card; the 6 branch children are leaf cards.
    expect(keys(m)[0]).toEqual([ROOT_ID, 'n2', itemKey('n2', 0), itemKey('n2', 1)])
    expect(m.boxes).toHaveLength(7)
    expect(m.edges).toHaveLength(6) // edges only between cards
    for (const e of m.edges) expect(e.y2).toBeGreaterThan(e.y1)
  })

  it('merges single-child guesses too', () => {
    const g = buildGraph(
      build(EMPTY, { type: 'guess', cell: 0, value: 5 }, { type: 'guess', cell: 1, value: 3 }),
    )
    expect(keys(compactModel(g))).toEqual([[ROOT_ID, 'n2', 'n3']])
  })

  it('shortens long cards to 3 + "… n more" + 3, unless opened or pinned', () => {
    const g = buildGraph(chain(10)) // Start + guess + 10 = 12 rows
    const short = compactModel(g)
    const card = short.boxes[0]!
    expect(card.long).toBe(true)
    expect(card.open).toBe(false)
    expect(card.rows.map((r) => (r.item ? r.item.key : `more:${r.more}`))).toEqual([
      ROOT_ID,
      'n2',
      itemKey('n2', 0),
      'more:6',
      itemKey('n2', 7),
      itemKey('n2', 8),
      itemKey('n2', 9),
    ])
    expect(card.rows).toHaveLength(2 * CARD_EDGE_ROWS + 1)
    // Hidden items are located at the "more" row.
    expect(short.pos.get(itemKey('n2', 3))!.y).toBe(card.rows[3]!.y)
    expect(compactModel(g, new Set([ROOT_ID])).boxes[0]!.rows).toHaveLength(12)
    expect(compactModel(g, new Set(), [itemKey('n2', 4)]).boxes[0]!.open).toBe(true)
    expect(compactModel(g, new Set(), [itemKey('n2', 9)]).boxes[0]!.open).toBe(false)
  })

  it('a collapsed guess ends its card', () => {
    const g = buildGraph(chain(3, { type: 'collapse', nodeId: 'n2' }))
    expect(keys(compactModel(g))).toEqual([[ROOT_ID, 'n2']])
  })

  it('lays out ~2,000 nodes in cards', () => {
    const m = compactModel(buildGraph(bigTree()), new Set(), ['b12#40'])
    expect(m.boxes).toHaveLength(26) // root card + 25 chain cards
    expect(m.boxes.find((b) => b.key === 'b12')!.open).toBe(true) // pinned hidden row
  })
})

describe('SearchGraph (compact, default)', () => {
  afterEach(() => localStorage.removeItem(GRAPH_LAYOUT_KEY))

  it('draws chain cards whose rows are individual tree items', async () => {
    const user = userEvent.setup()
    render(<Harness initial={chain(10)} />)
    expect(screen.getByRole('radio', { name: 'Compact' })).toBeChecked()
    expect(document.querySelectorAll('.chain-card')).toHaveLength(1)
    expect(document.querySelectorAll('.search-graph__edge')).toHaveLength(0)
    // 3 + 3 rows shown; the selected last row is visible.
    expect(screen.getAllByRole('treeitem')).toHaveLength(6)
    expect(item(/^r2c2 equals 7/)).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: 'Show 6 more steps' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(12)
    await user.click(item(/^r1c5 equals 7/))
    expect(screen.getByTestId('selection')).toHaveTextContent('n2@3')
  })

  it('↑/↓ walk row by row across card boundaries and reveal hidden rows', async () => {
    const user = userEvent.setup()
    render(<Harness initial={chain(10, { type: 'select', nodeId: ROOT_ID })} />)
    act(() => item(/^Start/).focus())
    for (let i = 0; i < 5; i++) await user.keyboard('{ArrowDown}')
    // r1c5 is in the hidden middle part: the card opens for it.
    expect(item(/^r1c5 equals 7/)).toHaveFocus()
    expect(screen.getAllByRole('treeitem')).toHaveLength(12)
  })

  it('crosses from a card to the next one at a branch point', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initial={chain(1, { type: 'branch', cell: 9 }, { type: 'select', nodeId: ROOT_ID })}
      />,
    )
    act(() => item(/^Start/).focus())
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(document.activeElement).toHaveAttribute('data-kind', 'guess')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^r2c1 equals/)
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^r2c1 equals/)
  })

  it('marks dead rows and dims what follows; collapse shows +n', () => {
    const tree = build(
      EMPTY,
      { type: 'guess', cell: 0, value: 5 },
      { type: 'place', cell: 1, value: 3 },
      { type: 'place', cell: 9, value: 5 },
      { type: 'place', cell: 40, value: 1 },
    )
    const { unmount } = render(<Harness initial={tree} />)
    const bad = item(/^r2c1 equals 5/)
    expect(bad.querySelector('.graph-node__cross')).not.toBeNull()
    expect(item(/^r5c5 equals 1/)).toHaveClass('graph-node--under-dead')
    unmount()
    render(<Harness initial={chain(3, { type: 'collapse', nodeId: 'n2' })} />)
    expect(screen.getByText('+3')).toBeInTheDocument()
  })

  it('remembers the layout choice in localStorage', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness initial={chain(2)} />)
    await user.click(screen.getByRole('radio', { name: 'Expanded' }))
    expect(localStorage.getItem(GRAPH_LAYOUT_KEY)).toBe('expanded')
    expect(document.querySelectorAll('.chain-card')).toHaveLength(0)
    unmount()
    render(<Harness initial={chain(2)} />)
    expect(screen.getByRole('radio', { name: 'Expanded' })).toBeChecked()
  })
})
