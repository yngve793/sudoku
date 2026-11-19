/**
 * Timing benchmarks for the search graph at ~2,000 nodes. Skipped in the
 * default `npm test` (wall-clock thresholds flake under CPU load); run with
 * `npm run test:perf`, ideally on an idle machine.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bigTree } from '../../test/searchTrees'
import { compactModel } from './graphLayout'
import { buildGraph, selectedItemKey } from './graphModel'
import { GRAPH_LAYOUT_KEY } from './graphPrefs'
import { SearchGraph } from './SearchGraph'
import { findNode } from './searchReducer'

const enabled = import.meta.env.VITE_PERF === 'true'

function time(fn: () => void): number {
  const started = performance.now()
  fn()
  return performance.now() - started
}

describe.runIf(enabled)('search graph performance (~2,000 nodes)', () => {
  beforeEach(() => localStorage.removeItem(GRAPH_LAYOUT_KEY))
  afterEach(() => localStorage.removeItem(GRAPH_LAYOUT_KEY))

  it('builds and lays out quickly', () => {
    const tree = bigTree()
    let graph = buildGraph(tree)
    expect(time(() => (graph = buildGraph(tree)))).toBeLessThan(500)
    expect(time(() => compactModel(graph, new Set(), ['b12#40']))).toBeLessThan(300)
  })

  it.each(['compact', 'expanded'] as const)(
    'renders the %s view windowed, and Fit, in reasonable time',
    { timeout: 60_000 },
    async (layout) => {
      localStorage.setItem(GRAPH_LAYOUT_KEY, layout)
      const user = userEvent.setup()
      const tree = bigTree()
      const node = findNode(tree, tree.selected_node_id)!
      const ms = time(() => {
        render(
          <SearchGraph
            tree={tree}
            selectedKey={selectedItemKey(node, null)}
            onSelectItem={() => undefined}
            onToggleCollapse={() => undefined}
          />,
        )
      })
      expect(ms).toBeLessThan(2000)
      const started = performance.now()
      await user.click(screen.getByRole('button', { name: 'Fit' }))
      expect(performance.now() - started).toBeLessThan(3000)
    },
  )
})
