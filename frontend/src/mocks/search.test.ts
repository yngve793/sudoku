import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { gamesApi } from '../api/endpoints'
import type { SearchTree } from '../api/types'
import { parseGrid } from '../features/game/grid'
import { findContradiction } from '../features/search/constraints'
import { createTree, searchReducer, createSearchState } from '../features/search/searchReducer'
import { loginAsDemo, seedGame } from '../test/utils'
import { db } from './db'
import { mockPropagate } from './propagate'

const SOLVED = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'

function blank(board: string, cells: number[]): number[] {
  const grid = parseGrid(board)
  for (const c of cells) grid[c] = 0
  return grid
}

describe('mockPropagate (naked + hidden singles to a fixpoint)', () => {
  it('fills naked singles in order', () => {
    const result = mockPropagate(blank(SOLVED, [0, 40, 80]))
    expect(result.placements).toEqual([
      { cell: 0, value: 5, technique: 'Naked Single' },
      { cell: 40, value: 5, technique: 'Naked Single' },
      { cell: 80, value: 9, technique: 'Naked Single' },
    ])
    expect(result.contradiction).toBeNull()
    expect(result.grid.join('')).toBe(SOLVED)
  })

  it('uses hidden singles when no naked single exists', () => {
    // Only 1s in rows 2/3 and columns 2/3 around box 1: r1c1 is the only place
    // for 1 in box 1, but it still has many candidates.
    const grid = parseGrid('0'.repeat(81))
    grid[3 * 9 + 1] = 1 // r4c2
    grid[6 * 9 + 2] = 1 // r7c3
    grid[1 * 9 + 4] = 1 // r2c5
    grid[2 * 9 + 7] = 1 // r3c8
    const result = mockPropagate(grid)
    expect(result.placements[0]).toEqual({ cell: 0, value: 1, technique: 'Hidden Single' })
  })

  it('returns no placements for an already contradictory grid', () => {
    const grid = parseGrid(`55${'0'.repeat(79)}`)
    const result = mockPropagate(grid)
    expect(result.placements).toEqual([])
    expect(result.contradiction).toEqual(findContradiction(grid))
  })

  it('stops at the first contradiction', () => {
    // Consistent, but following its singles leads to a contradiction after 14 steps.
    const grid = parseGrid(
      '500078910000095308008342567059000000020850700700000000001000284280400600040286075',
    )
    expect(findContradiction(grid)).toBeNull()
    const result = mockPropagate(grid)
    expect(result.placements).toHaveLength(14)
    expect(result.contradiction).not.toBeNull()
    expect(findContradiction(result.grid)).toEqual(result.contradiction)
    // Every placement before the last one left the grid consistent.
    const partial = grid.slice()
    for (const p of result.placements.slice(0, -1)) partial[p.cell] = p.value
    expect(findContradiction(partial)).toBeNull()
  })

  it('respects maxPlacements', () => {
    expect(mockPropagate(blank(SOLVED, [0, 40, 80]), 1).placements).toHaveLength(1)
  })
})

describe('mock search endpoints', () => {
  it('propagate returns placements, penalty and the running total without bumping version', async () => {
    await loginAsDemo()
    const game = seedGame()
    // The solution with two holes: both are naked singles.
    const board = game.solution.split('')
    const holes = [...game.givens].flatMap((c, i) => (c === '0' ? [i] : [])).slice(0, 2)
    for (const h of holes) board[h] = '0'
    const res = await gamesApi.propagate(game.id, board.join(''))
    expect(res.placements).toHaveLength(2)
    expect(res.penalty).toBe(4)
    expect(res.auto_placements).toBe(2)
    const again = await gamesApi.propagate(game.id, board.join(''))
    expect(again.auto_placements).toBe(4)
    expect(db.games.find((g) => g.id === game.id)?.version).toBe(1)
    const fetched = await gamesApi.get(game.id)
    expect(fetched.auto_placements).toBe(4)
    expect(fetched.search_costs).toEqual({ auto_placement: 2 })
  })

  it('propagate rejects modified givens and finished games', async () => {
    await loginAsDemo()
    const game = seedGame()
    const given = [...game.givens].findIndex((c) => c !== '0')
    const changed = game.givens.split('')
    changed[given] = changed[given] === '1' ? '2' : '1'
    await expect(gamesApi.propagate(game.id, changed.join(''))).rejects.toMatchObject({
      status: 422,
      code: 'givens_modified',
    })
    const done = seedGame({ status: 'completed' })
    await expect(gamesApi.propagate(done.id, done.givens)).rejects.toMatchObject({
      status: 409,
      code: 'game_not_in_progress',
    })
  })

  it('PATCH stores, keeps (omitted) and clears (null) the tree', async () => {
    await loginAsDemo()
    const game = seedGame()
    const tree = searchReducer(createSearchState(), { type: 'create', rootBoard: game.givens }).tree
    const body = { current: game.givens, notes: {}, elapsed_seconds: 1 }
    let res = await gamesApi.save(game.id, { ...body, version: 1, search_tree: tree })
    expect(res.search_tree).toEqual(tree)
    res = await gamesApi.save(game.id, { ...body, version: res.version })
    expect(res.search_tree).toEqual(tree)
    res = await gamesApi.save(game.id, { ...body, version: res.version, search_tree: null })
    expect(res.search_tree).toBeNull()
  })

  it.each<[string, (t: SearchTree) => unknown]>([
    ['an unknown top-level field', (t) => ({ ...t, extra: 1 })],
    ['an unknown node field', (t) => ({ ...t, nodes: t.nodes.map((n) => ({ ...n, x: 1 })) })],
    [
      'a missing node field',
      (t) => ({ ...t, nodes: t.nodes.map(({ branch_cell: _b, ...n }) => n) }),
    ],
    ['an unknown selected node', (t) => ({ ...t, selected_node_id: 'nope' })],
    ['two roots', (t) => ({ ...t, nodes: [...t.nodes, { ...t.nodes[0]!, id: 'n2' }] })],
    [
      'a non-root node without choice',
      (t) => ({ ...t, nodes: [...t.nodes, { ...t.nodes[0]!, id: 'n2', parent_id: 'n1' }] }),
    ],
    [
      'a cycle',
      (t) => ({
        ...t,
        nodes: [
          ...t.nodes,
          { ...t.nodes[0]!, id: 'a', parent_id: 'b', choice: { cell: 0, value: 1 } },
          { ...t.nodes[0]!, id: 'b', parent_id: 'a', choice: { cell: 0, value: 2 } },
        ],
      }),
    ],
    [
      'more than 500 nodes',
      (t) => ({
        ...t,
        nodes: [
          ...t.nodes,
          ...Array.from({ length: 500 }, (_, i) => ({
            ...t.nodes[0]!,
            id: `x${i}`,
            parent_id: 'n1',
            choice: { cell: 0, value: 1 },
          })),
        ],
      }),
    ],
    [
      'a too long explanation',
      (t) => ({
        ...t,
        nodes: [
          {
            ...t.nodes[0]!,
            contradiction: {
              kind: 'duplicate',
              cells: [0],
              digit: 1,
              unit: 'row 1',
              explanation: 'x'.repeat(501),
            },
          },
        ],
      }),
    ],
  ])('PATCH rejects a tree with %s (422 validation_error)', async (_name, mutate) => {
    await loginAsDemo()
    const game = seedGame()
    const tree = mutate(createTree(game.givens)) as SearchTree
    const request = gamesApi.save(game.id, {
      current: game.givens,
      notes: {},
      elapsed_seconds: 1,
      version: 1,
      search_tree: tree,
    })
    await expect(request).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(db.games.find((g) => g.id === game.id)?.version).toBe(1)
  })

  it('PATCH rejects a root_board that changes the givens (422 givens_modified)', async () => {
    await loginAsDemo()
    const game = seedGame()
    const given = [...game.givens].findIndex((c) => c !== '0')
    const root = game.givens.split('')
    root[given] = root[given] === '1' ? '2' : '1'
    const tree = createTree(root.join(''))
    const error = await gamesApi
      .save(game.id, {
        current: game.givens,
        notes: {},
        elapsed_seconds: 1,
        version: 1,
        search_tree: tree,
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 422, code: 'givens_modified' })
    expect(db.games.find((g) => g.id === game.id)?.version).toBe(1)
  })
})
