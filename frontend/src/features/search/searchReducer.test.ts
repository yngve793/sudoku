import { describe, expect, it } from 'vitest'
import type { SearchTree } from '../../api/types'
import { parseGrid } from '../game/grid'
import { candidates, findContradiction } from './constraints'
import {
  MAX_NODES,
  ROOT_ID,
  canApply,
  cellMarks,
  childrenOf,
  createSearchState,
  createTree,
  deadReason,
  describeNode,
  findNode,
  nodeBoard,
  nodeLabel,
  parseSearchTree,
  pathEntries,
  pathTo,
  searchReducer,
  selectedBoard,
  selectedNode,
  subtreeIds,
  toWireTree,
  type SearchAction,
  type SearchState,
} from './searchReducer'

const SOLVED = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'
/** Consistent board where every candidate (3, 6, 9) of cell 35 (r4c9) is a contradiction. */
const TRAP = '004000012002090300190000507800000020426800001700920054061050080200000635340080070'
const TRAP_CELL = 35
const EMPTY = '0'.repeat(81)

function run(state: SearchState, ...actions: SearchAction[]): SearchState {
  return actions.reduce(searchReducer, state)
}

function start(board = EMPTY, mode: 'manual' | 'auto' = 'manual'): SearchState {
  const s = run(createSearchState(), { type: 'create', rootBoard: board })
  return mode === 'auto' ? run(s, { type: 'setMode', mode: 'auto' }) : s
}

function tree(state: SearchState): SearchTree {
  if (!state.tree) throw new Error('no tree')
  return state.tree
}

function node(state: SearchState, id: string) {
  const n = findNode(tree(state), id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}

const sel = (state: SearchState) => tree(state).selected_node_id

describe('test boards', () => {
  it('TRAP is consistent and every option for r4c9 fails', () => {
    const board = parseGrid(TRAP)
    expect(findContradiction(board)).toBeNull()
    expect(candidates(board, TRAP_CELL)).toEqual([3, 6, 9])
    for (const v of [3, 6, 9]) {
      const next = board.slice()
      next[TRAP_CELL] = v
      expect(findContradiction(next)).not.toBeNull()
    }
  })
})

describe('createTree / create / clear / load', () => {
  it('creates a root snapshot with the exact persisted shape', () => {
    expect(createTree(TRAP)).toEqual({
      version: 1,
      root_board: TRAP,
      mode: 'manual',
      selected_node_id: ROOT_ID,
      nodes: [
        {
          id: ROOT_ID,
          parent_id: null,
          choice: null,
          placements: [],
          status: 'open',
          contradiction: null,
          branch_cell: null,
          collapsed: false,
        },
      ],
    })
  })

  it('rejects an invalid board', () => {
    expect(() => createTree('123')).toThrow()
  })

  it('marks a contradictory or complete root', () => {
    const bad = `55${EMPTY.slice(2)}`
    expect(createTree(bad).nodes[0]?.status).toBe('dead')
    expect(createTree(SOLVED).nodes[0]?.status).toBe('solved')
  })

  it('create replaces any tree (reset) and bumps the revision', () => {
    let s = start(EMPTY)
    s = run(s, { type: 'guess', cell: 0, value: 1 })
    expect(tree(s).nodes).toHaveLength(2)
    const before = s.revision
    s = run(s, { type: 'create', rootBoard: TRAP })
    expect(tree(s).nodes).toHaveLength(1)
    expect(tree(s).root_board).toBe(TRAP)
    expect(s.revision).toBe(before + 1)
  })

  it('clear removes the tree once', () => {
    const s = run(start(), { type: 'clear' })
    expect(s.tree).toBeNull()
    expect(run(s, { type: 'clear' })).toBe(s)
  })

  it('actions without a tree are no-ops', () => {
    const s = createSearchState()
    for (const action of [
      { type: 'select', nodeId: ROOT_ID },
      { type: 'guess', cell: 0, value: 1 },
      { type: 'branch', cell: 0 },
      { type: 'place', cell: 0, value: 1 },
      { type: 'erase', cell: 0 },
      { type: 'delete' },
      { type: 'setMode', mode: 'auto' },
      { type: 'collapse', nodeId: ROOT_ID },
    ] satisfies SearchAction[]) {
      expect(searchReducer(s, action)).toBe(s)
    }
  })

  it('load validates without bumping the revision', () => {
    const saved = tree(run(start(TRAP), { type: 'guess', cell: 0, value: 5 }))
    const s = run(createSearchState(), { type: 'load', tree: saved })
    expect(s.tree).toEqual(saved)
    expect(s.revision).toBe(0)
    expect(run(createSearchState(), { type: 'load', tree: null }).tree).toBeNull()
    expect(run(createSearchState(), { type: 'load', tree: { nope: true } }).tree).toBeNull()
  })
})

describe('guess', () => {
  it('adds a child with the choice and selects it', () => {
    const s = run(start(), { type: 'guess', cell: 20, value: 7 })
    const child = node(s, sel(s))
    expect(child.parent_id).toBe(ROOT_ID)
    expect(child.choice).toEqual({ cell: 20, value: 7 })
    expect(child.placements).toEqual([])
    expect(nodeBoard(tree(s), child.id)[20]).toBe(7)
    expect(nodeLabel(child)).toBe('r3c3=7')
  })

  it('distinct choices become siblings; the same choice reuses the child', () => {
    let s = run(start(), { type: 'guess', cell: 20, value: 7 }, { type: 'select', nodeId: ROOT_ID })
    s = run(s, { type: 'guess', cell: 20, value: 8 }, { type: 'select', nodeId: ROOT_ID })
    s = run(s, { type: 'guess', cell: 20, value: 7 })
    expect(childrenOf(tree(s), ROOT_ID).map((c) => c.choice?.value)).toEqual([7, 8])
    expect(node(s, sel(s)).choice).toEqual({ cell: 20, value: 7 })
  })

  it('nests guesses along a path', () => {
    const s = run(
      start(),
      { type: 'guess', cell: 0, value: 1 },
      { type: 'guess', cell: 80, value: 9 },
    )
    expect(pathTo(tree(s), sel(s)).map(nodeLabel)).toEqual(['Start', 'r1c1=1', 'r9c9=9'])
  })

  it('ignores filled cells, bad input and dead nodes', () => {
    const s = start(TRAP)
    expect(run(s, { type: 'guess', cell: 2, value: 1 })).toBe(s) // r1c3 is a given
    expect(run(s, { type: 'guess', cell: 0, value: 0 })).toBe(s)
    expect(run(s, { type: 'guess', cell: 81, value: 1 })).toBe(s)
    const dead = run(s, { type: 'guess', cell: TRAP_CELL, value: 3 })
    expect(node(dead, sel(dead)).status).toBe('dead')
    expect(run(dead, { type: 'guess', cell: 0, value: 5 })).toBe(dead)
  })

  it('stops at the node limit', () => {
    const nodes = [
      ...createTree(EMPTY).nodes,
      ...Array.from({ length: MAX_NODES - 1 }, (_, i) => ({
        ...createTree(EMPTY).nodes[0]!,
        id: `x${i}`,
        parent_id: ROOT_ID,
        choice: { cell: 1, value: 1 },
      })),
    ]
    const full = run(createSearchState(), {
      type: 'load',
      tree: { ...createTree(EMPTY), nodes },
    })
    expect(tree(full).nodes).toHaveLength(MAX_NODES)
    expect(run(full, { type: 'guess', cell: 5, value: 5 })).toBe(full)
    expect(run(full, { type: 'branch', cell: 5 })).toBe(full)
  })

  it('queues the new node for propagation in auto mode only', () => {
    expect(run(start(), { type: 'guess', cell: 0, value: 1 }).pending).toEqual([])
    const s = run(start(EMPTY, 'auto'), { type: 'guess', cell: 0, value: 1 })
    expect(s.pending).toEqual([sel(s)])
  })
})

describe('branch on all candidates', () => {
  it('creates one child per candidate, records branch_cell, keeps the parent selected', () => {
    const s = run(start(TRAP), { type: 'branch', cell: TRAP_CELL })
    const kids = childrenOf(tree(s), ROOT_ID)
    expect(kids.map((k) => k.choice)).toEqual([
      { cell: TRAP_CELL, value: 3 },
      { cell: TRAP_CELL, value: 6 },
      { cell: TRAP_CELL, value: 9 },
    ])
    expect(node(s, ROOT_ID).branch_cell).toBe(TRAP_CELL)
    expect(sel(s)).toBe(ROOT_ID)
  })

  it('reuses an existing child with the same choice', () => {
    let s = run(start(TRAP), { type: 'guess', cell: TRAP_CELL, value: 6 })
    s = run(s, { type: 'select', nodeId: ROOT_ID }, { type: 'branch', cell: TRAP_CELL })
    expect(childrenOf(tree(s), ROOT_ID)).toHaveLength(3)
  })

  it('ignores filled cells and dead nodes', () => {
    const s = start(TRAP)
    expect(run(s, { type: 'branch', cell: 2 })).toBe(s)
    expect(run(s, { type: 'branch', cell: -1 })).toBe(s)
    const dead = run(s, { type: 'guess', cell: TRAP_CELL, value: 3 })
    expect(run(dead, { type: 'branch', cell: 0 })).toBe(dead)
  })

  it('queues every new child in auto mode', () => {
    const s = run(start(TRAP, 'auto'), { type: 'branch', cell: 0 })
    expect(s.pending).toEqual(childrenOf(tree(s), ROOT_ID).map((c) => c.id))
  })
})

describe('status rules', () => {
  it('a node with a contradiction is dead, with the reason', () => {
    const s = run(start(TRAP), { type: 'guess', cell: TRAP_CELL, value: 3 })
    const dead = node(s, sel(s))
    expect(dead.status).toBe('dead')
    expect(dead.contradiction).toEqual(findContradiction(nodeBoard(tree(s), dead.id)))
    expect(deadReason(dead)).toBe(dead.contradiction?.explanation.replace(/\.$/, ''))
    expect(canApply(dead)).toBe(false)
  })

  it('a parent dies when every branch_cell child is dead', () => {
    const s = run(start(TRAP), { type: 'branch', cell: TRAP_CELL })
    expect(childrenOf(tree(s), ROOT_ID).every((c) => c.status === 'dead')).toBe(true)
    const root = node(s, ROOT_ID)
    expect(root.status).toBe('dead')
    expect(root.contradiction).toBeNull()
    expect(describeNode(root)).toBe('Start position, dead: every option for r4c9 fails.')
  })

  it('manual guesses covering every option do not kill the parent (branch_cell only)', () => {
    let s = start(TRAP)
    for (const v of [3, 6, 9])
      s = run(s, { type: 'select', nodeId: ROOT_ID }, { type: 'guess', cell: TRAP_CELL, value: v })
    expect(node(s, ROOT_ID).status).toBe('open')
  })

  it('a parent stays alive while one branch option is missing', () => {
    let s = run(start(TRAP), { type: 'branch', cell: TRAP_CELL })
    const six = childrenOf(tree(s), ROOT_ID).find((c) => c.choice?.value === 6)!
    s = run(s, { type: 'delete', nodeId: six.id })
    expect(node(s, ROOT_ID).status).toBe('open')
    expect(node(s, ROOT_ID).branch_cell).toBe(TRAP_CELL)
  })

  it('propagates death upwards recursively', () => {
    // Root branches on r1c1; inside every child, branching on r4c9 kills it.
    let s = run(start(TRAP), { type: 'branch', cell: 0 })
    const kids = childrenOf(tree(s), ROOT_ID)
    expect(kids.length).toBeGreaterThan(1)
    for (const kid of kids) {
      s = run(s, { type: 'select', nodeId: kid.id })
      if (node(s, kid.id).status === 'open') {
        expect(node(s, ROOT_ID).status).toBe('open')
        s = run(s, { type: 'branch', cell: TRAP_CELL })
      }
      expect(node(s, kid.id).status).toBe('dead')
    }
    expect(node(s, ROOT_ID).status).toBe('dead')
  })

  it('a complete board without contradiction is solved', () => {
    const board = `0${SOLVED.slice(1)}`
    let s = run(start(board), { type: 'guess', cell: 0, value: 5 })
    expect(node(s, sel(s)).status).toBe('solved')
    expect(describeNode(node(s, sel(s)))).toBe('r1c1 equals 5, solved.')
    expect(canApply(node(s, sel(s)))).toBe(true)
    s = run(s, { type: 'select', nodeId: ROOT_ID })
    expect(canApply(node(s, ROOT_ID))).toBe(false)
  })

  it('status is recomputed when placements change', () => {
    let s = run(start(TRAP), { type: 'guess', cell: 0, value: 5 })
    const id = sel(s)
    // r1c2 = 4 duplicates the given 4 at r1c3.
    s = run(s, { type: 'place', cell: 1, value: 4 })
    expect(node(s, id).status).toBe('dead')
    s = run(s, { type: 'erase', cell: 1 })
    expect(node(s, id).status).toBe('open')
  })
})

describe('placements', () => {
  const at = () => run(start(TRAP), { type: 'guess', cell: 0, value: 5 })

  it('adds manual placements to the selected node', () => {
    const s = run(at(), { type: 'place', cell: 1, value: 3 })
    expect(node(s, sel(s)).placements).toEqual([{ cell: 1, value: 3, source: 'manual' }])
    expect(selectedBoard(tree(s))[1]).toBe('3')
  })

  it('never places in the root, a given, or a cell filled on the path', () => {
    const root = start(TRAP)
    expect(run(root, { type: 'place', cell: 0, value: 5 })).toBe(root)
    const s = at()
    expect(run(s, { type: 'place', cell: 2, value: 1 })).toBe(s)
    expect(run(s, { type: 'place', cell: 0, value: 1 })).toBe(s) // own choice
    expect(run(s, { type: 'place', cell: 1, value: 10 })).toBe(s)
  })

  it('the same digit again removes it; another digit replaces it and drops later autos', () => {
    let s = run(at(), { type: 'place', cell: 1, value: 3 })
    const id = sel(s)
    s = run(s, {
      type: 'autoResult',
      nodeId: id,
      placements: [{ cell: 9, value: 6 }],
      contradiction: null,
    })
    s = run(s, { type: 'place', cell: 20, value: 7 })
    s = run(s, { type: 'place', cell: 1, value: 8 })
    expect(node(s, id).placements).toEqual([
      { cell: 1, value: 8, source: 'manual' },
      { cell: 20, value: 7, source: 'manual' },
    ])
    s = run(s, { type: 'place', cell: 1, value: 8 })
    expect(node(s, id).placements).toEqual([{ cell: 20, value: 7, source: 'manual' }])
  })

  it('queues propagation after a placement in auto mode, not after a removal', () => {
    let s = run(start(TRAP, 'auto'), { type: 'guess', cell: 0, value: 5 })
    const id = sel(s)
    s = run(s, { type: 'autoDone', nodeId: id }, { type: 'place', cell: 1, value: 3 })
    expect(s.pending).toEqual([id])
    s = run(s, { type: 'autoDone', nodeId: id }, { type: 'place', cell: 1, value: 3 })
    expect(s.pending).toEqual([])
  })

  it('erase removes a manual placement plus the auto placements after it', () => {
    let s = run(at(), { type: 'place', cell: 1, value: 3 })
    const id = sel(s)
    s = run(
      s,
      { type: 'autoResult', nodeId: id, placements: [{ cell: 9, value: 6 }], contradiction: null },
      { type: 'place', cell: 20, value: 7 },
    )
    const withAuto = s
    expect(run(withAuto, { type: 'erase', cell: 9 })).toBe(withAuto) // auto: not erasable
    expect(run(withAuto, { type: 'erase', cell: 40 })).toBe(withAuto)
    s = run(s, { type: 'erase', cell: 1 })
    expect(node(s, id).placements).toEqual([{ cell: 20, value: 7, source: 'manual' }])
  })

  it('descendants see ancestor placements; a later entry wins a cell', () => {
    let s = run(at(), { type: 'place', cell: 1, value: 3 }, { type: 'guess', cell: 9, value: 6 })
    expect(pathEntries(tree(s), sel(s))).toEqual([
      { cell: 0, value: 5 },
      { cell: 1, value: 3 },
      { cell: 9, value: 6 },
    ])
    const child = sel(s)
    // Parent later fills the child's choice cell: the child's own choice still wins there.
    s = run(s, { type: 'select', nodeId: node(s, child).parent_id! })
    s = run(s, { type: 'place', cell: 9, value: 8 })
    expect(nodeBoard(tree(s), child)[9]).toBe(6)
    expect(nodeBoard(tree(s), sel(s))[9]).toBe(8)
  })

  it('cellMarks describes how each cell on the path was filled', () => {
    let s = run(at(), { type: 'place', cell: 1, value: 3 })
    s = run(s, {
      type: 'autoResult',
      nodeId: sel(s),
      placements: [{ cell: 9, value: 6 }],
      contradiction: null,
    })
    s = run(s, { type: 'guess', cell: 20, value: 7 })
    const marks = cellMarks(tree(s))
    expect(marks.get(0)).toEqual({ origin: 'choice', own: false })
    expect(marks.get(1)).toEqual({ origin: 'manual', own: false })
    expect(marks.get(9)).toEqual({ origin: 'auto', own: false })
    expect(marks.get(20)).toEqual({ origin: 'choice', own: true })
    expect(marks.has(2)).toBe(false) // given
  })
})

describe('autoResult / autoDone', () => {
  it('appends auto placements, skipping filled or invalid cells, and dequeues', () => {
    let s = run(start(TRAP, 'auto'), { type: 'guess', cell: 0, value: 5 })
    const id = sel(s)
    s = run(s, {
      type: 'autoResult',
      nodeId: id,
      placements: [
        { cell: 1, value: 3 },
        { cell: 2, value: 9 }, // given
        { cell: 1, value: 8 }, // filled by the first one
        { cell: 99, value: 1 },
      ],
      contradiction: null,
    })
    expect(node(s, id).placements).toEqual([{ cell: 1, value: 3, source: 'auto' }])
    expect(s.pending).toEqual([])
    expect(describeNode(node(s, id))).toBe('r1c1 equals 5, 1 implication.')
  })

  it('trusts the server contradiction if the client finds none', () => {
    let s = run(start(TRAP, 'auto'), { type: 'guess', cell: 0, value: 5 })
    const server = {
      kind: 'no_candidates' as const,
      cells: [40],
      digit: null,
      unit: null,
      explanation: 'No digit can go in r5c5.',
    }
    s = run(s, { type: 'autoResult', nodeId: sel(s), placements: [], contradiction: server })
    expect(node(s, sel(s)).status).toBe('dead')
    expect(node(s, sel(s)).contradiction).toEqual(server)
  })

  it('ignores results for unknown nodes or the root (but dequeues them)', () => {
    const s = { ...start(TRAP, 'auto'), pending: ['n1', 'zz'] }
    const a = run(s, { type: 'autoResult', nodeId: 'zz', placements: [], contradiction: null })
    expect(a.pending).toEqual(['n1'])
    expect(a.tree).toBe(s.tree)
    const b = run(a, {
      type: 'autoResult',
      nodeId: 'n1',
      placements: [{ cell: 0, value: 5 }],
      contradiction: null,
    })
    expect(node(b, ROOT_ID).placements).toEqual([])
    expect(run(b, { type: 'autoDone', nodeId: 'n1' })).toBe(b)
  })
})

describe('delete', () => {
  it('removes the subtree, selects the parent and dequeues removed nodes', () => {
    let s = run(
      start(EMPTY, 'auto'),
      { type: 'guess', cell: 0, value: 1 },
      { type: 'guess', cell: 1, value: 2 },
    )
    const [, a, b] = tree(s).nodes.map((n) => n.id)
    s = run(s, { type: 'select', nodeId: a! }, { type: 'delete' })
    expect(tree(s).nodes.map((n) => n.id)).toEqual([ROOT_ID])
    expect(sel(s)).toBe(ROOT_ID)
    expect(s.pending).not.toContain(b)
  })

  it('keeps the selection when deleting another branch', () => {
    let s = run(start(), { type: 'guess', cell: 0, value: 1 })
    const a = sel(s)
    s = run(s, { type: 'select', nodeId: ROOT_ID }, { type: 'guess', cell: 0, value: 2 })
    const b = sel(s)
    s = run(s, { type: 'delete', nodeId: a })
    expect(sel(s)).toBe(b)
  })

  it('clears branch_cell once no branch child is left; never deletes the root', () => {
    let s = run(start(TRAP), { type: 'branch', cell: 0 })
    for (const kid of childrenOf(tree(s), ROOT_ID)) s = run(s, { type: 'delete', nodeId: kid.id })
    expect(node(s, ROOT_ID).branch_cell).toBeNull()
    expect(run(s, { type: 'delete', nodeId: ROOT_ID })).toBe(s)
    expect(run(s, { type: 'delete', nodeId: 'missing' })).toBe(s)
  })
})

describe('select / setMode / collapse', () => {
  it('select ignores unknown or already selected nodes', () => {
    const s = start()
    expect(run(s, { type: 'select', nodeId: 'nope' })).toBe(s)
    expect(run(s, { type: 'select', nodeId: ROOT_ID })).toBe(s)
  })

  it('setMode switches mode; manual clears the queue', () => {
    let s = run(start(EMPTY, 'auto'), { type: 'guess', cell: 0, value: 1 })
    expect(s.pending).toHaveLength(1)
    expect(run(s, { type: 'setMode', mode: 'auto' })).toBe(s)
    s = run(s, { type: 'setMode', mode: 'manual' })
    expect(tree(s).mode).toBe('manual')
    expect(s.pending).toEqual([])
  })

  it('collapse toggles nodes with children only and keeps the selection visible', () => {
    let s = run(start(), { type: 'guess', cell: 0, value: 1 }, { type: 'guess', cell: 1, value: 2 })
    const leaf = sel(s)
    expect(run(s, { type: 'collapse', nodeId: leaf })).toBe(s)
    s = run(s, { type: 'collapse', nodeId: ROOT_ID })
    expect(node(s, ROOT_ID).collapsed).toBe(true)
    expect(sel(s)).toBe(ROOT_ID)
    expect(run(s, { type: 'collapse', nodeId: ROOT_ID, collapsed: true })).toBe(s)
    // Selecting a hidden node expands its ancestors again.
    s = run(s, { type: 'select', nodeId: leaf })
    expect(node(s, ROOT_ID).collapsed).toBe(false)
  })

  it('selectedNode and subtreeIds', () => {
    const s = run(
      start(),
      { type: 'guess', cell: 0, value: 1 },
      { type: 'guess', cell: 1, value: 2 },
    )
    expect(selectedNode(s)?.choice).toEqual({ cell: 1, value: 2 })
    expect(selectedNode(createSearchState())).toBeNull()
    expect(subtreeIds(tree(s), ROOT_ID).size).toBe(3)
  })
})

describe('parseSearchTree', () => {
  const valid = () => tree(run(start(TRAP), { type: 'branch', cell: TRAP_CELL }))

  it('round-trips a valid tree and recomputes statuses', () => {
    const t = valid()
    const tampered = {
      ...t,
      nodes: t.nodes.map((n) => ({ ...n, status: 'open', contradiction: null })),
    }
    expect(parseSearchTree(tampered)).toEqual(t)
  })

  it('rejects malformed trees', () => {
    const t = valid()
    const root = t.nodes[0]!
    const bad: unknown[] = [
      null,
      'x',
      { ...t, version: 2 },
      { ...t, root_board: 'abc' },
      { ...t, nodes: 'x' },
      { ...t, nodes: [] },
      { ...t, nodes: [root, root] },
      { ...t, nodes: [{ ...root, id: '' }] },
      { ...t, nodes: [{ ...root, id: 'x'.repeat(37) }] },
      { ...t, nodes: [{ ...root, choice: { cell: 1, value: 1 } }] },
      {
        ...t,
        nodes: [root, { ...root, id: 'n9', parent_id: 'missing', choice: { cell: 0, value: 1 } }],
      },
      {
        ...t,
        nodes: [root, { ...root, id: 'n9', parent_id: ROOT_ID, choice: { cell: 0, value: 10 } }],
      },
      {
        ...t,
        nodes: [
          root,
          {
            ...root,
            id: 'n9',
            parent_id: ROOT_ID,
            choice: { cell: 0, value: 1 },
            placements: [{ cell: 81, value: 1, source: 'manual' }],
          },
        ],
      },
      { ...t, nodes: [root, { ...root, id: 'n9', parent_id: ROOT_ID, choice: null }] },
      { ...t, nodes: [5] },
    ]
    for (const b of bad) expect(parseSearchTree(b)).toBeNull()
  })

  it('drops unreachable cycles and falls back to the root selection', () => {
    const t = valid()
    const cycle = [
      { ...t.nodes[1]!, id: 'a', parent_id: 'b' },
      { ...t.nodes[1]!, id: 'b', parent_id: 'a' },
    ]
    const parsed = parseSearchTree({ ...t, selected_node_id: 'a', nodes: [...t.nodes, ...cycle] })
    expect(parsed?.nodes.map((n) => n.id)).toEqual(t.nodes.map((n) => n.id))
    expect(parsed?.selected_node_id).toBe(ROOT_ID)
  })
})

describe('toWireTree', () => {
  it('emits exactly the schema fields and nothing else', () => {
    const t = tree(run(start(TRAP), { type: 'guess', cell: TRAP_CELL, value: 3 }))
    const extra = {
      ...t,
      uiOnly: 1,
      nodes: t.nodes.map((n) => ({ ...n, x: 10, placements: n.placements })),
    } as unknown as SearchTree
    const wire = toWireTree(extra)
    expect(Object.keys(wire).sort()).toEqual(
      ['mode', 'nodes', 'root_board', 'selected_node_id', 'version'].sort(),
    )
    for (const n of wire.nodes)
      expect(Object.keys(n).sort()).toEqual(
        [
          'branch_cell',
          'choice',
          'collapsed',
          'contradiction',
          'id',
          'parent_id',
          'placements',
          'status',
        ].sort(),
      )
    expect(wire).toEqual(t)
    expect(Object.keys(wire.nodes[1]!.contradiction!).sort()).toEqual([
      'cells',
      'digit',
      'explanation',
      'kind',
      'unit',
    ])
  })
})
