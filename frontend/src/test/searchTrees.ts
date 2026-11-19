import type { SearchNode, SearchTree } from '../api/types'
import { ROOT_ID, parseSearchTree } from '../features/search/searchReducer'

const SOLVED = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'
const EMPTY = '0'.repeat(81)
const sol = (i: number) => Number(SOLVED[i])

/** ~2,000 graph nodes: 25 sibling guesses with 80 placements each. */
export function bigTree(): SearchTree {
  const root: SearchNode = {
    id: ROOT_ID,
    parent_id: null,
    choice: null,
    placements: [],
    status: 'open',
    contradiction: null,
    branch_cell: null,
    collapsed: false,
  }
  const nodes: SearchNode[] = [root]
  for (let n = 0; n < 25; n++) {
    nodes.push({
      ...root,
      id: `b${n}`,
      parent_id: ROOT_ID,
      choice: { cell: 0, value: sol(0) },
      placements: Array.from({ length: 80 }, (_, k) => ({
        cell: k + 1,
        value: sol(k + 1),
        source: k % 2 ? 'auto' : 'manual',
      })),
    })
  }
  return parseSearchTree({
    version: 1,
    root_board: EMPTY,
    mode: 'auto',
    selected_node_id: 'b12',
    nodes,
  })!
}
