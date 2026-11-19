/**
 * In-memory "server database" behind the MSW handlers.
 *
 * This simulates backend state only. In browser mock mode, users/games/scores
 * are persisted to localStorage so a page reload, or another tab such as the
 * search-tree tab, sees the fake server's data (like a real, shared server; each
 * tab reads it when it starts); no auth tokens are persisted (the fake refresh cookie encodes the
 * user id, the way a real server would look up its own DB).
 */
import type {
  Difficulty,
  Game,
  HintCosts,
  NotesWire,
  ScoreBreakdown,
  SearchCosts,
  SearchTree,
} from '../api/types'
import { DIFFICULTIES } from '../api/types'
import { makePuzzle } from './puzzles'

export interface MockUser {
  id: number
  username: string
  email: string
  password: string
  verified: boolean
  created_at: string
  last_login_at: string | null
}

export interface MockGame {
  id: number
  user_id: number
  difficulty: Difficulty
  status: Game['status']
  givens: string
  solution: string
  current: string
  notes: NotesWire
  elapsed_seconds: number
  hints_used: number
  /** One entry per hint request (its stage), like the backend's hint_events. */
  hint_stages: number[]
  mistakes: number
  score: number | null
  version: number
  started_at: string
  updated_at: string
  completed_at: string | null
  /** Search mode (PLAN.md §5.5); optional so older stored mock DBs still load. */
  search_tree?: SearchTree | null
  auto_placements?: number
}

export interface MockEmail {
  to: string
  kind: 'verify_email' | 'reset_password'
  token: string
  link: string
}

export interface MockDb {
  users: MockUser[]
  games: MockGame[]
  /** token -> user id (single use) */
  verifyTokens: Record<string, number>
  resetTokens: Record<string, number>
  /** access token -> user id */
  accessTokens: Record<string, number>
  outbox: MockEmail[]
  nextId: number
}

// Mirrors backend services/scoring.py.
export const HINT_COSTS: HintCosts = { 1: 10, 2: 20, 3: 40 }
export const BASE_SCORE: Record<Difficulty, number> = {
  beginner: 50,
  easy: 100,
  medium: 250,
  hard: 500,
  expert: 1000,
  master: 2000,
  extreme: 4000,
}
export const PAR_SECONDS: Record<Difficulty, number> = {
  beginner: 5 * 60,
  easy: 8 * 60,
  medium: 12 * 60,
  hard: 20 * 60,
  expert: 30 * 60,
  master: 45 * 60,
  extreme: 60 * 60,
}
export const MISTAKE_PENALTY = 15
export const SEARCH_COSTS: SearchCosts = { auto_placement: 2 }

export const DEMO_USER = { username: 'demo', email: 'demo@example.com', password: 'password123' }

const STORAGE_KEY = 'sudoku.mock-server-db.v4'
let persist = false

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString()
}

function seed(): MockDb {
  const db: MockDb = {
    users: [],
    games: [],
    verifyTokens: {},
    resetTokens: {},
    accessTokens: {},
    outbox: [],
    nextId: 1,
  }
  const add = (username: string, verified = true) => {
    const user: MockUser = {
      id: db.nextId++,
      username,
      email: `${username.toLowerCase()}@example.com`,
      password: 'password123',
      verified,
      created_at: hoursAgo(24 * 30),
      last_login_at: null,
    }
    db.users.push(user)
    return user
  }
  add(DEMO_USER.username)
  const others = ['ada_l', 'gridmaster', 'NinePlusNine', 'pencilmark', 'xwing_fan', 'sudokat']
  others.forEach((name, n) => {
    const user = add(name)
    DIFFICULTIES.forEach((difficulty, d) => {
      const puzzle = makePuzzle(difficulty, 1000 + n * 10 + d)
      const elapsed = Math.round(PAR_SECONDS[difficulty] * (0.6 + ((n * 7 + d * 3) % 10) / 6))
      const hints = (n + d) % 4
      const completed = hoursAgo([2, 20, 60, 200, 500, 3][(n + d) % 6]!)
      db.games.push({
        id: db.nextId++,
        user_id: user.id,
        difficulty,
        status: 'completed',
        givens: puzzle.givens,
        solution: puzzle.solution,
        current: puzzle.solution,
        notes: {},
        elapsed_seconds: elapsed,
        hints_used: hints,
        hint_stages: Array.from({ length: hints }, () => 1),
        mistakes: n % 3,
        score: 0,
        version: 1,
        started_at: completed,
        updated_at: completed,
        completed_at: completed,
      })
      const game = db.games[db.games.length - 1]!
      game.score = computeScore(game).total
    })
  })
  // An unverified user whose scores must never appear publicly.
  add('unverified_user', false)
  return db
}

export function computeScore(game: MockGame): ScoreBreakdown {
  const base = BASE_SCORE[game.difficulty]
  const par = PAR_SECONDS[game.difficulty]
  const elapsed = Math.max(0, game.elapsed_seconds)
  const slow = par * 4
  const timeFactor =
    elapsed <= par ? 1.5 : elapsed >= slow ? 0.5 : 1.5 - ((elapsed - par) / (slow - par)) * 1.0
  const hintPenalty = game.hint_stages.reduce(
    (sum, stage) => sum + HINT_COSTS[stage as 1 | 2 | 3],
    0,
  )
  const mistakePenalty = MISTAKE_PENALTY * Math.max(0, game.mistakes)
  const searchPenalty = SEARCH_COSTS.auto_placement * (game.auto_placements ?? 0)
  return {
    base,
    par_seconds: par,
    time_factor: timeFactor,
    hint_penalty: hintPenalty,
    mistake_penalty: mistakePenalty,
    search_penalty: searchPenalty,
    total: Math.max(
      0,
      Math.round(base * timeFactor) - hintPenalty - mistakePenalty - searchPenalty,
    ),
  }
}

function load(): MockDb {
  if (persist) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) return { ...(JSON.parse(raw) as MockDb), accessTokens: {} }
    } catch {
      /* fall through to a fresh seed */
    }
  }
  return seed()
}

export let db: MockDb = seed()

export function enablePersistence(): void {
  persist = true
  db = load()
}

export function saveDb(): void {
  if (!persist) return
  const { accessTokens: _accessTokens, ...rest } = db
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rest, accessTokens: {} }))
}

export function resetMockDb(): void {
  db = seed()
}

export function nextId(): number {
  return db.nextId++
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

export function toWireGame(game: MockGame): Game {
  return {
    id: game.id,
    difficulty: game.difficulty,
    status: game.status,
    givens: game.givens,
    current: game.current,
    notes: game.notes,
    elapsed_seconds: game.elapsed_seconds,
    hints_used: game.hints_used,
    mistakes: game.mistakes,
    score: game.score,
    version: game.version,
    started_at: game.started_at,
    updated_at: game.updated_at,
    completed_at: game.completed_at,
    hint_costs: HINT_COSTS,
    search_tree: game.search_tree ?? null,
    auto_placements: game.auto_placements ?? 0,
    search_costs: SEARCH_COSTS,
  }
}
