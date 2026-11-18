/**
 * Mock puzzle source for MSW. NOT used by the app itself: the real puzzles,
 * solutions and hints come from the backend. Here we shuffle a known solution
 * (digit relabelling, row/column swaps within bands, transposition) and dig
 * holes; uniqueness is not guaranteed, which is fine for UI development.
 */
import type { Difficulty, Hint, HintStage } from '../api/types'
import { PEERS, UNITS, boxOf, cellName, colOf, rowOf } from '../features/game/grid'

const BASE_SOLUTION =
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179'

export const CLUES: Record<Difficulty, number> = {
  beginner: 44,
  easy: 37,
  medium: 32,
  hard: 28,
  expert: 25,
  master: 24,
  extreme: 23,
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = items.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

function bandOrder(rand: () => number): number[] {
  return shuffle([0, 1, 2], rand).flatMap((band) =>
    shuffle([0, 1, 2], rand).map((r) => band * 3 + r),
  )
}

export function makePuzzle(
  difficulty: Difficulty,
  seed: number,
): { givens: string; solution: string } {
  const rand = mulberry32(seed)
  const base = [...BASE_SOLUTION].map(Number)
  const relabel = [0, ...shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rand)]
  const rows = bandOrder(rand)
  const cols = bandOrder(rand)
  const transpose = rand() < 0.5
  const solution = Array.from({ length: 81 }, (_, i) => {
    let r = rows[rowOf(i)]!
    let c = cols[colOf(i)]!
    if (transpose) [r, c] = [c, r]
    return relabel[base[r * 9 + c]!]!
  })
  // Dig symmetric pairs until we hit the clue target.
  const givens = solution.slice()
  let clues = 81
  for (const i of shuffle(
    Array.from({ length: 41 }, (_, k) => k),
    rand,
  )) {
    if (clues <= CLUES[difficulty]) break
    const j = 80 - i
    givens[i] = 0
    givens[j] = 0
    clues -= i === j ? 1 : 2
  }
  return { givens: givens.join(''), solution: solution.join('') }
}

function candidates(cells: number[], index: number): number[] {
  const used = new Set(PEERS[index]!.map((p) => cells[p]))
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => !used.has(d))
}

/** What sudoku_validator.next_hint returns (unstaged). */
interface RawHint {
  kind: 'error' | 'step'
  technique: string | null
  /** Target first. */
  cells: number[]
  value: number | null
  explanation: string
}

function rawHint(cells: number[], solution: number[]): RawHint | null {
  const wrong = cells.flatMap((v, i) => (v !== 0 && v !== solution[i] ? [i] : []))
  if (wrong.length) {
    return {
      kind: 'error',
      technique: null,
      cells: wrong,
      value: null,
      explanation: `${wrong.map(cellName).join(', ')} ${wrong.length === 1 ? 'is' : 'are'} incorrect.`,
    }
  }
  if (cells.every((v) => v !== 0)) return null
  for (let i = 0; i < 81; i++) {
    if (cells[i]) continue
    const c = candidates(cells, i)
    if (c.length === 1)
      return {
        kind: 'step',
        technique: 'Naked Single',
        cells: [i],
        value: c[0]!,
        explanation: `Naked Single: every digit except ${c[0]} already appears in the row, column or box of ${cellName(i)}, so ${cellName(i)} = ${c[0]}.`,
      }
  }
  for (const unit of UNITS) {
    for (let d = 1; d <= 9; d++) {
      if (unit.some((i) => cells[i] === d)) continue
      const spots = unit.filter((i) => !cells[i] && candidates(cells, i).includes(d))
      if (spots.length === 1) {
        const i = spots[0]!
        return {
          kind: 'step',
          technique: 'Hidden Single',
          cells: [i],
          value: d,
          explanation: `Hidden Single: ${d} fits only in ${cellName(i)} within its unit, so ${cellName(i)} = ${d}.`,
        }
      }
    }
  }
  const i = cells.findIndex((v) => v === 0)
  return {
    kind: 'step',
    technique: 'Locked Candidates',
    cells: [i],
    value: solution[i]!,
    explanation: `Locked Candidates: eliminations leave ${cellName(i)} = ${solution[i]}.`,
  }
}

const UNIT_KINDS = ['box', 'row', 'column'] as const

function unitCells(kind: (typeof UNIT_KINDS)[number], index: number): number[] {
  if (kind === 'row') return Array.from({ length: 9 }, (_, c) => index * 9 + c)
  if (kind === 'column') return Array.from({ length: 9 }, (_, r) => r * 9 + index)
  const br = Math.floor(index / 3)
  const bc = index % 3
  return Array.from({ length: 9 }, (_, k) => (br * 3 + Math.floor(k / 3)) * 9 + bc * 3 + (k % 3))
}

/** Mirrors backend services/hints.py choose_region: the unit of cells[0] holding most hint cells. */
function chooseRegion(cells: number[]) {
  const anchor = cells[0]!
  const indices = { box: boxOf(anchor), row: rowOf(anchor), column: colOf(anchor) }
  let best: (typeof UNIT_KINDS)[number] = 'box'
  let bestCount = -1
  for (const kind of UNIT_KINDS) {
    const unit = new Set(unitCells(kind, indices[kind]))
    const count = cells.filter((c) => unit.has(c)).length
    if (count > bestCount) {
      best = kind
      bestCount = count
    }
  }
  return { kind: best, index: indices[best], cells: unitCells(best, indices[best]) }
}

const withArticle = (t: string) =>
  ['Locked Candidates', 'Simple Coloring'].includes(t)
    ? t
    : `${'AEIOX'.includes(t[0]!) ? 'an' : 'a'} ${t}`

/**
 * Staged hint like the backend (services/hints.py). Returns null when the
 * board is complete (the API answers 409 no_hint_available).
 */
export function mockHint(
  current: string,
  solution: string,
  stage: HintStage,
  penalty: number,
): Hint | null {
  const hint = rawHint([...current].map(Number), [...solution].map(Number))
  if (!hint) return null
  if (hint.kind === 'error') {
    return stage === 1
      ? {
          kind: 'error',
          stage,
          technique: null,
          cells: [],
          value: null,
          explanation: 'Your board contains a mistake.',
          penalty,
        }
      : {
          kind: 'error',
          stage,
          technique: null,
          cells: hint.cells,
          value: null,
          explanation: hint.explanation,
          penalty,
        }
  }
  if (stage === 1) {
    const region = chooseRegion(hint.cells)
    return {
      kind: 'step',
      stage,
      technique: hint.technique,
      cells: region.cells,
      value: null,
      explanation: `Try ${withArticle(hint.technique ?? '')} in ${region.kind} ${region.index + 1}.`,
      penalty,
    }
  }
  if (stage === 2) {
    const redacted = hint.explanation.replace(new RegExp(`\\b${hint.value}\\b`, 'g'), '?')
    return {
      kind: 'step',
      stage,
      technique: hint.technique,
      cells: hint.cells,
      value: null,
      explanation: redacted,
      penalty,
    }
  }
  return {
    kind: 'step',
    stage,
    technique: hint.technique,
    cells: hint.cells,
    value: hint.value,
    explanation: hint.explanation,
    penalty,
  }
}
