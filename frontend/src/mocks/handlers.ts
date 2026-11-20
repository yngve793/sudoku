/**
 * MSW handlers mirroring the real backend (backend/openapi.json + its services):
 * same paths, status codes, `{detail, code}` errors, `{message}` acknowledgements,
 * staged hints, scoring and leaderboard rules. Keep in sync with the backend.
 */
import { delay, http, HttpResponse, type DefaultBodyType, type StrictRequest } from 'msw'
import type {
  CompletedGame,
  Difficulty,
  GameUpdateRequest,
  LeaderboardEntry,
  LeaderboardPeriod,
  Me,
  ScoresMe,
  TokenResponse,
} from '../api/types'
import { DIFFICULTIES } from '../api/types'
import {
  HINT_COSTS,
  SEARCH_COSTS,
  computeScore,
  db,
  nextId,
  randomToken,
  saveDb,
  toWireGame,
  type MockGame,
  type MockUser,
} from './db'
import { makePuzzle, mockHint } from './puzzles'
import { mockPropagate } from './propagate'
import { findContradiction } from '../features/search/constraints'
import {
  mockRating,
  mockRecognition,
  parseCornersField,
  polygonArea,
  simulatedError,
  sniffImage,
  type ImportEndpoint,
} from './imports'
import { countSolutions } from './solver'

const API = '*/api/v1'
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const RESERVED = new Set(['admin', 'root', 'system', 'moderator', 'support', 'sudoku'])
const GRID_RE = /^[0-9]{81}$/
const MAX_SEARCH_NODES = 500
const MAX_SEARCH_BYTES = 256 * 1024
const REFRESH_COOKIE = 'refresh_token'
const COOKIE_PATH = '/api/v1/auth'
/** Same reply whether or not the account exists (no enumeration). */
const ACCEPTED = 'If the address can receive email, a message is on its way.'

let latency = 0
/** Artificial latency for the browser dev server (tests use 0). */
export function setMockLatency(ms: number): void {
  latency = ms
}

function err(status: number, code: string, detail: string, headers?: Record<string, string>) {
  return HttpResponse.json({ detail, code }, { status, headers })
}

/** Same shape as the backend's RequestValidationError handler: "loc: msg; loc: msg". */
function validation(...parts: string[]) {
  return err(422, 'validation_error', parts.join('; '))
}

const message = (text: string, status = 200) => HttpResponse.json({ message: text }, { status })

async function json<T>(request: StrictRequest<DefaultBodyType>): Promise<Partial<T>> {
  try {
    return ((await request.json()) ?? {}) as Partial<T>
  } catch {
    return {}
  }
}

function currentUser(request: Request): MockUser | null {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const id = db.accessTokens[token]
  return db.users.find((u) => u.id === id) ?? null
}

function unauthorized(request: Request) {
  return request.headers.get('Authorization')
    ? err(401, 'invalid_token', 'Invalid or expired access token')
    : err(401, 'not_authenticated', 'Not authenticated')
}

const clearCookie = `${REFRESH_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict`

function issueTokens(user: MockUser) {
  const access = randomToken()
  db.accessTokens[access] = user.id
  const refresh = `mock.${user.id}.${randomToken()}`
  const body: TokenResponse = {
    access_token: access,
    token_type: 'bearer',
    expires_in: 900,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      email_verified: user.verified,
      created_at: user.created_at,
    },
  }
  return HttpResponse.json(body, {
    headers: {
      'Set-Cookie': `${REFRESH_COOKIE}=${refresh}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict`,
    },
  })
}

function sendEmail(user: MockUser, kind: 'verify_email' | 'reset_password') {
  const token = randomToken()
  if (kind === 'verify_email') db.verifyTokens[token] = user.id
  else db.resetTokens[token] = user.id
  const path = kind === 'verify_email' ? 'verify-email' : 'reset-password'
  const origin = typeof window === 'undefined' ? 'http://localhost:5173' : window.location.origin
  const link = `${origin}/${path}?token=${token}`
  db.outbox.push({ to: user.email, kind, token, link })
  if (latency > 0) {
    // Browser mock mode: the "email" is printed to the console.
    console.info(`[mock email] ${kind} for ${user.email}: ${link}`)
  }
}

function findGame(user: MockUser, id: string | readonly string[] | undefined): MockGame | null {
  return db.games.find((g) => g.id === Number(id) && g.user_id === user.id) ?? null
}

/** FastAPI `game_id: int` path parameter. */
const GAME_ID_RE = /^-?\d+$/
const badGameId = () =>
  validation('path.game_id: Input should be a valid integer, unable to parse string as an integer')

const gameNotFound = () => err(404, 'not_found', 'Game not found')
const notInProgress = () => err(409, 'game_not_in_progress', 'This game is no longer in progress')

function periodStart(period: LeaderboardPeriod): number {
  const now = Date.now()
  if (period === 'day') return now - 86_400_000
  if (period === 'week') return now - 7 * 86_400_000
  return 0
}

type RankedEntry = LeaderboardEntry & { user_id: number; game_id: number }

function rankedEntries(difficulty: Difficulty | null, period: LeaderboardPeriod): RankedEntry[] {
  const since = periodStart(period)
  const verified = new Map(db.users.filter((u) => u.verified).map((u) => [u.id, u]))
  return db.games
    .filter(
      (g) =>
        g.status === 'completed' &&
        g.score !== null &&
        g.source !== 'imported' &&
        (difficulty === null || g.difficulty === difficulty) &&
        verified.has(g.user_id) &&
        Date.parse(g.completed_at ?? '') >= since,
    )
    .sort(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        Date.parse(a.completed_at ?? '') - Date.parse(b.completed_at ?? '') ||
        a.id - b.id,
    )
    .map((g, i) => ({
      rank: i + 1,
      username: verified.get(g.user_id)!.username,
      difficulty: g.difficulty!,
      score: g.score ?? 0,
      elapsed_seconds: g.elapsed_seconds,
      hints_used: g.hints_used,
      completed_at: g.completed_at ?? '',
      user_id: g.user_id,
      game_id: g.id,
    }))
}

const publicEntry = ({ user_id: _u, game_id: _g, ...entry }: RankedEntry): LeaderboardEntry => entry

type DifficultyParam = { ok: true; value: Difficulty | null } | { ok: false }

function parseDifficulty(value: string | null): DifficultyParam {
  if (value === null || value === '') return { ok: true, value: null }
  const found = DIFFICULTIES.find((d) => d === value)
  return found ? { ok: true, value: found } : { ok: false }
}

function parsePeriod(value: string | null): LeaderboardPeriod | null {
  if (value === null) return 'all'
  return value === 'day' || value === 'week' || value === 'all' ? value : null
}

const badDifficulty = () =>
  validation(
    "query.difficulty: Input should be 'beginner', 'easy', 'medium', 'hard', 'expert', 'master' or 'extreme'",
  )
const badPeriod = () => validation("query.period: Input should be 'day', 'week' or 'all'")

/** FastAPI `Query(default, ge=min, le=max)` integer parameter: value or a 422 message. */
function intQuery(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max = Infinity,
): number | string {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN
  if (!Number.isInteger(value))
    return `query.${name}: Input should be a valid integer, unable to parse string as an integer`
  if (value < min) return `query.${name}: Input should be greater than or equal to ${min}`
  if (value > max) return `query.${name}: Input should be less than or equal to ${max}`
  return value
}

function userStats(user: MockUser): Me['stats'] {
  const games = db.games.filter((g) => g.user_id === user.id)
  const completed = games.filter((g) => g.status === 'completed')
  const best: Record<string, number> = {}
  // Unrated imports count towards the totals but have no per-difficulty best.
  for (const g of completed)
    if (g.difficulty) best[g.difficulty] = Math.max(best[g.difficulty] ?? 0, g.score ?? 0)
  return {
    games_started: games.length,
    games_completed: completed.length,
    total_score: completed.reduce((sum, g) => sum + (g.score ?? 0), 0),
    best_scores: best,
  }
}

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNodeId = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= 36

/** Pydantic `extra="forbid"` + every field required. */
function exactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
  where: string,
): string | null {
  for (const k of keys) if (!(k in obj)) return `${where}.${k}: Field required`
  for (const k of Object.keys(obj))
    if (!keys.includes(k)) return `${where}.${k}: Extra inputs are not permitted`
  return null
}

function contradictionProblem(c: unknown, where: string): string | null {
  if (c === null) return null
  if (!isObj(c)) return `${where}: Input should be an object`
  const keys = exactKeys(c, ['kind', 'cells', 'digit', 'unit', 'explanation'], where)
  if (keys) return keys
  if (!['duplicate', 'no_candidates', 'digit_nowhere'].includes(c.kind as string))
    return `${where}.kind: invalid`
  if (!Array.isArray(c.cells) || c.cells.length > 81 || c.cells.some((x) => !isInt(x, 0, 80)))
    return `${where}.cells: invalid`
  if (c.digit !== null && !isInt(c.digit, 1, 9)) return `${where}.digit: invalid`
  if (c.unit !== null && (typeof c.unit !== 'string' || c.unit.length > 32))
    return `${where}.unit: invalid`
  if (typeof c.explanation !== 'string' || c.explanation.length > 500)
    return `${where}.explanation: invalid`
  return null
}

/** Mirrors backend `schemas/search.py` SearchTree validation (422 validation_error). */
function searchTreeProblem(tree: unknown): string | null {
  const w = 'body.search_tree'
  if (!isObj(tree)) return `${w}: Input should be an object`
  const top = exactKeys(tree, ['version', 'root_board', 'mode', 'selected_node_id', 'nodes'], w)
  if (top) return top
  if (tree.version !== 1) return `${w}.version: Input should be 1`
  if (typeof tree.root_board !== 'string' || !GRID_RE.test(tree.root_board))
    return `${w}.root_board: String should match pattern '^[0-9]{81}$'`
  if (tree.mode !== 'manual' && tree.mode !== 'auto')
    return `${w}.mode: Input should be 'manual' or 'auto'`
  if (!isNodeId(tree.selected_node_id)) return `${w}.selected_node_id: invalid`
  const nodes = tree.nodes
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > MAX_SEARCH_NODES)
    return `${w}.nodes: List should have 1 to ${MAX_SEARCH_NODES} items`
  const byId = new Map<string, Record<string, unknown>>()
  for (const [i, n] of nodes.entries()) {
    const at = `${w}.nodes.${i}`
    if (!isObj(n)) return `${at}: Input should be an object`
    const keys = exactKeys(
      n,
      [
        'id',
        'parent_id',
        'choice',
        'placements',
        'status',
        'contradiction',
        'branch_cell',
        'collapsed',
      ],
      at,
    )
    if (keys) return keys
    if (!isNodeId(n.id)) return `${at}.id: invalid`
    if (n.parent_id !== null && !isNodeId(n.parent_id)) return `${at}.parent_id: invalid`
    if (n.choice !== null) {
      if (!isObj(n.choice)) return `${at}.choice: invalid`
      const ck = exactKeys(n.choice, ['cell', 'value'], `${at}.choice`)
      if (ck) return ck
      if (!isInt(n.choice.cell, 0, 80) || !isInt(n.choice.value, 1, 9))
        return `${at}.choice: invalid`
    }
    if (!Array.isArray(n.placements) || n.placements.length > 81) return `${at}.placements: invalid`
    for (const p of n.placements as unknown[]) {
      if (!isObj(p)) return `${at}.placements: invalid`
      const pk = exactKeys(p, ['cell', 'value', 'source'], `${at}.placements`)
      if (pk) return pk
      if (!isInt(p.cell, 0, 80) || !isInt(p.value, 1, 9)) return `${at}.placements: invalid`
      if (p.source !== 'manual' && p.source !== 'auto') return `${at}.placements.source: invalid`
    }
    if (!['open', 'dead', 'solved'].includes(n.status as string)) return `${at}.status: invalid`
    const cp = contradictionProblem(n.contradiction, `${at}.contradiction`)
    if (cp) return cp
    if (n.branch_cell !== null && !isInt(n.branch_cell, 0, 80)) return `${at}.branch_cell: invalid`
    if (typeof n.collapsed !== 'boolean') return `${at}.collapsed: Input should be a valid boolean`
    if (byId.has(n.id)) return `${w}: Value error, duplicate node id '${n.id}'`
    byId.set(n.id, n)
  }
  const all = [...byId.values()]
  const roots = all.filter((n) => n.parent_id === null)
  if (roots.length !== 1)
    return `${w}: Value error, the tree must have exactly one root, found ${roots.length}`
  const root = roots[0]!
  if (root.choice !== null || (root.placements as unknown[]).length)
    return `${w}: Value error, the root node must have no choice and no placements`
  const children = new Map<string, string[]>()
  for (const n of all) {
    if (n.parent_id === null) continue
    const parent = n.parent_id as string
    if (!byId.has(parent))
      return `${w}: Value error, node '${n.id as string}' has unknown parent_id`
    if (n.choice === null)
      return `${w}: Value error, non-root node '${n.id as string}' must have a choice`
    children.set(parent, [...(children.get(parent) ?? []), n.id as string])
  }
  const reached = new Set([root.id as string])
  const stack = [root.id as string]
  while (stack.length)
    for (const c of children.get(stack.pop()!) ?? []) {
      reached.add(c)
      stack.push(c)
    }
  if (reached.size !== byId.size) return `${w}: Value error, parent_id links contain a cycle`
  if (!byId.has(tree.selected_node_id))
    return `${w}: Value error, selected_node_id must be the id of a node`
  if (new TextEncoder().encode(JSON.stringify(tree)).length > MAX_SEARCH_BYTES)
    return `${w}: Value error, the search tree is too large`
  return null
}

const IMAGE_ERRORS = {
  unsupported_image: [415, 'Unsupported image type; use JPEG, PNG or WebP'],
  image_too_large: [413, 'The image is too large (at most 10 MB and 40 megapixels)'],
  image_unreadable: [422, 'The image could not be read'],
} as const

function simulated(endpoint: ImportEndpoint) {
  const e = simulatedError(endpoint)
  return e ? err(e.status, e.code, e.detail ?? `Simulated ${e.code}`) : null
}

/** Mirrors ImportBoardIn validation plus the shared `givens_modified` rule. */
async function importBoard(
  request: StrictRequest<DefaultBodyType>,
): Promise<{ givens: string; current: string } | Response> {
  const body = await json<{ givens: string; current: string }>(request)
  const problems: string[] = []
  for (const field of ['givens', 'current'] as const) {
    const value = body[field]
    if (value === undefined) problems.push(`${field}: Field required`)
    else if (typeof value !== 'string' || !GRID_RE.test(value))
      problems.push(`${field}: String should match pattern '^[0-9]{81}$'`)
  }
  if (problems.length) return validation(...problems)
  const givens = body.givens!
  const current = body.current!
  if ([...givens].some((g, i) => g !== '0' && current[i] !== g))
    return err(422, 'givens_modified', 'The board must keep every given')
  return { givens, current }
}

const toCells = (grid: string) => [...grid].map(Number)

export const handlers = [
  // Latency for the browser dev server; falls through to the real handler.
  http.all(`${API}/*`, async () => {
    if (latency) await delay(latency)
  }),

  http.get(`${API}/health`, () => HttpResponse.json({ status: 'ok', database: 'ok' })),

  // ---------- auth ----------
  http.post(`${API}/auth/register`, async ({ request }) => {
    const body = await json<{ username: string; email: string; password: string }>(request)
    const username = body.username ?? ''
    const email = (body.email ?? '').trim().toLowerCase()
    const password = body.password ?? ''
    const problems: string[] = []
    if (!USERNAME_RE.test(username))
      problems.push("username: String should match pattern '^[A-Za-z0-9_]{3,20}$'")
    if (!EMAIL_RE.test(email))
      problems.push(
        'email: value is not a valid email address: An email address must have an @-sign.',
      )
    if (password.length < 8) problems.push('password: String should have at least 8 characters')
    if (problems.length) return validation(...problems)
    if (RESERVED.has(username.toLowerCase()))
      return err(422, 'username_not_allowed', 'This username is not allowed')
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase()))
      return err(409, 'username_taken', 'This username is already taken')
    // An existing email gets the same 202 (no account enumeration).
    if (!db.users.some((u) => u.email === email)) {
      const user: MockUser = {
        id: nextId(),
        username,
        email,
        password,
        verified: false,
        created_at: new Date().toISOString(),
        last_login_at: null,
      }
      db.users.push(user)
      sendEmail(user, 'verify_email')
      saveDb()
    }
    return message('Check your email to verify your address and finish signing up.', 202)
  }),

  http.post(`${API}/auth/verify-email`, async ({ request }) => {
    const { token = '' } = await json<{ token: string }>(request)
    const userId = db.verifyTokens[token]
    const user = db.users.find((u) => u.id === userId)
    if (!user) return err(400, 'invalid_token', 'This link is invalid or has expired')
    Reflect.deleteProperty(db.verifyTokens, token)
    user.verified = true
    saveDb()
    return message('Email verified. You can now log in.')
  }),

  http.post(`${API}/auth/resend-verification`, async ({ request }) => {
    const { email = '' } = await json<{ email: string }>(request)
    if (!EMAIL_RE.test(email.trim())) return validation('email: value is not a valid email address')
    const user = db.users.find((u) => u.email === email.trim().toLowerCase())
    if (user && !user.verified) sendEmail(user, 'verify_email')
    saveDb()
    return message(ACCEPTED, 202)
  }),

  http.post(`${API}/auth/forgot-password`, async ({ request }) => {
    const { email = '' } = await json<{ email: string }>(request)
    if (!EMAIL_RE.test(email.trim())) return validation('email: value is not a valid email address')
    const user = db.users.find((u) => u.email === email.trim().toLowerCase())
    if (user) sendEmail(user, 'reset_password')
    saveDb()
    return message(ACCEPTED, 202)
  }),

  http.post(`${API}/auth/reset-password`, async ({ request }) => {
    const { token = '', new_password = '' } = await json<{ token: string; new_password: string }>(
      request,
    )
    if (new_password.length < 8)
      return validation('new_password: String should have at least 8 characters')
    const user = db.users.find((u) => u.id === db.resetTokens[token])
    if (!user) return err(400, 'invalid_token', 'This link is invalid or has expired')
    Reflect.deleteProperty(db.resetTokens, token)
    user.password = new_password
    // Revoke every session of that user.
    for (const [access, id] of Object.entries(db.accessTokens))
      if (id === user.id) Reflect.deleteProperty(db.accessTokens, access)
    saveDb()
    return message('Password updated. Please log in again.')
  }),

  http.post(`${API}/auth/login`, async ({ request }) => {
    const { email = '', password = '' } = await json<{ email: string; password: string }>(request)
    const id = email.trim().toLowerCase()
    // The backend accepts an email address or a username here.
    const user = db.users.find((u) => u.email === id || u.username.toLowerCase() === id)
    if (user?.password !== password)
      return err(401, 'invalid_credentials', 'Incorrect email or password')
    if (!user.verified)
      return err(403, 'email_not_verified', 'Please verify your email address first')
    user.last_login_at = new Date().toISOString()
    saveDb()
    return issueTokens(user)
  }),

  http.post(`${API}/auth/refresh`, ({ cookies }) => {
    const raw = cookies[REFRESH_COOKIE]
    const match = /^mock\.(\d+)\./.exec(raw ?? '')
    const user = match ? db.users.find((u) => u.id === Number(match[1])) : undefined
    if (!user)
      return err(401, 'invalid_token', 'Session expired, please log in again', {
        'Set-Cookie': clearCookie,
      })
    return issueTokens(user)
  }),

  http.post(`${API}/auth/logout`, ({ request }) => {
    const token = (request.headers.get('Authorization') ?? '').slice(7)
    Reflect.deleteProperty(db.accessTokens, token)
    return HttpResponse.json({ message: 'Logged out.' }, { headers: { 'Set-Cookie': clearCookie } })
  }),

  http.get(`${API}/me`, ({ request }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    const body: Me = {
      id: user.id,
      username: user.username,
      email: user.email,
      email_verified: user.verified,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
      stats: userStats(user),
    }
    return HttpResponse.json(body)
  }),

  // ---------- games ----------
  http.post(`${API}/games`, async ({ request }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    const { difficulty } = await json<{ difficulty: Difficulty }>(request)
    const level = parseDifficulty(difficulty ?? null)
    if (!level.ok || level.value === null)
      return validation(
        "difficulty: Input should be 'beginner', 'easy', 'medium', 'hard', 'expert', 'master' or 'extreme'",
      )
    for (const g of db.games)
      if (g.user_id === user.id && g.status === 'in_progress') g.status = 'abandoned'
    const id = nextId()
    const puzzle = makePuzzle(level.value, id * 7919)
    const now = new Date().toISOString()
    const game: MockGame = {
      id,
      user_id: user.id,
      difficulty: level.value,
      status: 'in_progress',
      givens: puzzle.givens,
      solution: puzzle.solution,
      current: puzzle.givens,
      notes: {},
      elapsed_seconds: 0,
      hints_used: 0,
      hint_stages: [],
      mistakes: 0,
      score: null,
      version: 1,
      started_at: now,
      updated_at: now,
      completed_at: null,
    }
    db.games.push(game)
    saveDb()
    return HttpResponse.json(toWireGame(game), { status: 201 })
  }),

  // ---------- photo import (PLAN.md §5.6) ----------
  http.post(`${API}/imports/recognize`, async ({ request }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    const fail = simulated('recognize')
    if (fail) return fail
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return validation('file: Field required')
    }
    const file = form.get('file')
    if (!file || typeof file === 'string') return validation('file: Field required')
    const rawCorners = form.get('corners')
    let corners = null
    if (typeof rawCorners === 'string' && rawCorners !== '') {
      const parsed = parseCornersField(rawCorners)
      if (typeof parsed === 'string') return validation(parsed)
      corners = parsed
    }
    const sniffed = sniffImage(new Uint8Array(await file.arrayBuffer()))
    if (!sniffed.ok) {
      const [status, detail] = IMAGE_ERRORS[sniffed.code]
      return err(status, sniffed.code, detail)
    }
    // Corners enclosing (almost) nothing: nothing to straighten.
    if (corners && polygonArea(corners) < 0.01 * sniffed.width * sniffed.height)
      return err(422, 'no_grid_found', 'No Sudoku grid was found inside the given corners')
    return HttpResponse.json(mockRecognition(sniffed.width, sniffed.height, corners))
  }),

  http.post(`${API}/imports/check`, async ({ request }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    const fail = simulated('check')
    if (fail) return fail
    const board = await importBoard(request)
    if (board instanceof Response) return board
    const contradiction = findContradiction(toCells(board.current))
    // Solution count and rating use the givens only (never leaks via `current`).
    const { count } = countSolutions(toCells(board.givens), 2)
    const rating = count === 1 ? mockRating(board.givens) : null
    return HttpResponse.json({
      consistent: contradiction === null,
      contradiction,
      solution_count: count as 0 | 1 | 2,
      difficulty: rating?.difficulty ?? null,
      rating_score: rating?.score ?? null,
    })
  }),

  http.post(`${API}/games/import`, async ({ request }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    const fail = simulated('import')
    if (fail) return fail
    const board = await importBoard(request)
    if (board instanceof Response) return board
    if (findContradiction(toCells(board.givens)))
      return err(422, 'puzzle_inconsistent', 'The givens contradict each other')
    const { count, solution } = countSolutions(toCells(board.givens), 2)
    if (count === 0 || !solution) return err(422, 'no_solution', 'The givens have no solution')
    if (count > 1) return err(422, 'multiple_solutions', 'The givens have more than one solution')
    for (const g of db.games)
      if (g.user_id === user.id && g.status === 'in_progress') g.status = 'abandoned'
    const now = new Date().toISOString()
    const game: MockGame = {
      id: nextId(),
      user_id: user.id,
      difficulty: mockRating(board.givens).difficulty,
      source: 'imported',
      status: 'in_progress',
      givens: board.givens,
      solution: solution.join(''),
      current: board.current,
      notes: {},
      elapsed_seconds: 0,
      hints_used: 0,
      hint_stages: [],
      mistakes: 0,
      score: null,
      version: 1,
      started_at: now,
      updated_at: now,
      completed_at: null,
    }
    db.games.push(game)
    saveDb()
    return HttpResponse.json(toWireGame(game), { status: 201 })
  }),

  http.get(`${API}/games/current`, ({ request }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    const game = db.games.find((g) => g.user_id === user.id && g.status === 'in_progress')
    if (!game) return err(404, 'not_found', 'In-progress game not found')
    return HttpResponse.json(toWireGame(game))
  }),

  http.get(`${API}/games/:id`, ({ request, params }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    if (!GAME_ID_RE.test(String(params.id))) return badGameId()
    const game = findGame(user, params.id)
    if (!game) return gameNotFound()
    return HttpResponse.json(toWireGame(game))
  }),

  http.patch(`${API}/games/:id`, async ({ request, params }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    if (!GAME_ID_RE.test(String(params.id))) return badGameId()
    const body = await json<GameUpdateRequest>(request)
    const current = body.current ?? ''
    if (!GRID_RE.test(current))
      return validation("current: String should match pattern '^[0-9]{81}$'")
    if (typeof body.version !== 'number') return validation('version: Field required')
    const tree = body.search_tree
    if (tree) {
      const problem = searchTreeProblem(tree)
      if (problem) return validation(problem)
    }
    const game = findGame(user, params.id)
    if (!game) return gameNotFound()
    if (game.status !== 'in_progress') return notInProgress()
    if ([...game.givens].some((g, i) => g !== '0' && current[i] !== g))
      return err(422, 'givens_modified', 'Given cells cannot be changed')
    if (tree && [...game.givens].some((g, i) => g !== '0' && tree.root_board[i] !== g))
      return err(422, 'givens_modified', 'Given cells cannot be changed')
    if (body.version !== game.version)
      return err(409, 'version_conflict', 'The game was changed elsewhere; reload and try again')
    game.current = current
    game.notes = Object.fromEntries(
      Object.entries(body.notes ?? {})
        .filter(([, digits]) => digits.length > 0)
        .map(([k, digits]) => [k, [...new Set(digits)].sort((a, b) => a - b)]),
    )
    game.elapsed_seconds = Math.max(game.elapsed_seconds, Math.floor(body.elapsed_seconds ?? 0))
    // Omitted = keep the saved tree; explicit null clears it.
    if (tree !== undefined) game.search_tree = tree
    game.version += 1
    game.updated_at = new Date().toISOString()
    saveDb()
    return HttpResponse.json(toWireGame(game))
  }),

  http.post(`${API}/games/:id/hint`, async ({ request, params }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    if (!GAME_ID_RE.test(String(params.id))) return badGameId()
    const { stage } = await json<{ stage: number }>(request)
    if (stage !== 1 && stage !== 2 && stage !== 3)
      return validation('stage: Input should be 1, 2 or 3')
    const game = findGame(user, params.id)
    if (!game) return gameNotFound()
    if (game.status !== 'in_progress') return notInProgress()
    const hint = mockHint(game.current, game.solution, stage, HINT_COSTS[stage])
    if (!hint) return err(409, 'no_hint_available', 'The board is already solved')
    game.hints_used += 1
    game.hint_stages.push(stage)
    saveDb()
    return HttpResponse.json(hint)
  }),

  // Search mode: auto implications. Does not change `version` (like hints).
  http.post(`${API}/games/:id/search/propagate`, async ({ request, params }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    if (!GAME_ID_RE.test(String(params.id))) return badGameId()
    const { board = '' } = await json<{ board: string }>(request)
    if (!GRID_RE.test(board)) return validation("board: String should match pattern '^[0-9]{81}$'")
    const game = findGame(user, params.id)
    if (!game) return gameNotFound()
    if (game.status !== 'in_progress') return notInProgress()
    if ([...game.givens].some((g, i) => g !== '0' && board[i] !== g))
      return err(422, 'givens_modified', 'Given cells cannot be changed')
    const result = mockPropagate([...board].map(Number))
    game.auto_placements = (game.auto_placements ?? 0) + result.placements.length
    saveDb()
    return HttpResponse.json({
      placements: result.placements,
      contradiction: result.contradiction,
      penalty: result.placements.length * SEARCH_COSTS.auto_placement,
      auto_placements: game.auto_placements,
    })
  }),

  http.post(`${API}/games/:id/check`, ({ request, params }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    if (!GAME_ID_RE.test(String(params.id))) return badGameId()
    const game = findGame(user, params.id)
    if (!game) return gameNotFound()
    if (game.status !== 'in_progress') return notInProgress()
    const wrong = [...game.current].flatMap((v, i) =>
      v !== '0' && v !== game.solution[i] ? [i] : [],
    )
    game.mistakes += wrong.length
    saveDb()
    return HttpResponse.json({ wrong_cells: wrong, mistakes: game.mistakes })
  }),

  http.post(`${API}/games/:id/complete`, ({ request, params }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    if (!GAME_ID_RE.test(String(params.id))) return badGameId()
    const game = findGame(user, params.id)
    if (!game) return gameNotFound()
    if (game.status !== 'in_progress') return notInProgress()
    if (game.current !== game.solution)
      return err(422, 'board_not_solved', 'The board is not correctly solved yet')
    const breakdown = computeScore(game)
    const now = new Date().toISOString()
    game.status = 'completed'
    game.completed_at = now
    game.updated_at = now
    game.score = breakdown.total
    game.version += 1
    saveDb()
    const body: CompletedGame = { ...toWireGame(game), score_breakdown: breakdown }
    return HttpResponse.json(body)
  }),

  // ---------- scores ----------
  http.get(`${API}/scores/me`, ({ request }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    const url = new URL(request.url)
    const limit = intQuery(url, 'limit', 50, 1, 200)
    if (typeof limit === 'string') return validation(limit)
    const offset = intQuery(url, 'offset', 0, 0)
    if (typeof offset === 'string') return validation(offset)
    const mine = db.games.filter((g) => g.user_id === user.id)
    const completed = mine
      .filter((g) => g.status === 'completed')
      .sort(
        (a, b) =>
          (b.score ?? 0) - (a.score ?? 0) ||
          Date.parse(a.completed_at ?? '') - Date.parse(b.completed_at ?? ''),
      )
    const best: ScoresMe['best'] = []
    for (const d of DIFFICULTIES) {
      const g = completed.find((x) => x.difficulty === d)
      if (g)
        best.push({
          game_id: g.id,
          difficulty: d,
          score: g.score ?? 0,
          elapsed_seconds: g.elapsed_seconds,
          hints_used: g.hints_used,
          completed_at: g.completed_at ?? '',
        })
    }
    const history: ScoresMe['history'] = mine
      .slice()
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id)
      .slice(offset, offset + limit)
      .map((g) => ({
        game_id: g.id,
        difficulty: g.difficulty,
        source: g.source ?? 'generated',
        status: g.status,
        score: g.score,
        elapsed_seconds: g.elapsed_seconds,
        hints_used: g.hints_used,
        mistakes: g.mistakes,
        started_at: g.started_at,
        completed_at: g.completed_at,
      }))
    return HttpResponse.json({ best, history })
  }),

  http.get(`${API}/leaderboard`, ({ request }) => {
    const url = new URL(request.url)
    const difficulty = parseDifficulty(url.searchParams.get('difficulty'))
    if (!difficulty.ok) return badDifficulty()
    const period = parsePeriod(url.searchParams.get('period'))
    if (!period) return badPeriod()
    const limit = intQuery(url, 'limit', 20, 1, 100)
    if (typeof limit === 'string') return validation(limit)
    const entries = rankedEntries(difficulty.value, period).slice(0, limit).map(publicEntry)
    return HttpResponse.json({ difficulty: difficulty.value, period, entries })
  }),

  http.get(`${API}/leaderboard/me`, ({ request }) => {
    const user = currentUser(request)
    if (!user) return unauthorized(request)
    const url = new URL(request.url)
    const difficulty = parseDifficulty(url.searchParams.get('difficulty'))
    if (!difficulty.ok) return badDifficulty()
    const period = parsePeriod(url.searchParams.get('period'))
    if (!period) return badPeriod()
    const ranked = rankedEntries(difficulty.value, period)
    const mine = ranked.find((e) => e.user_id === user.id)
    return HttpResponse.json({
      difficulty: difficulty.value,
      period,
      rank: mine ? mine.rank : null,
      total: ranked.length,
      entry: mine ? publicEntry(mine) : null,
    })
  }),
]
