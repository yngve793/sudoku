/**
 * Contract test: every response the MSW mock API returns must be declared by
 * `backend/openapi.json` (operation found by method + path template, status code
 * listed for that operation) and its JSON body must validate against the declared
 * response schema, in a strict mode that also rejects properties the backend's
 * models don't have. TypeScript types alone miss extra fields, wrong status codes
 * and malformed error bodies.
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsPlugin from 'ajv-formats'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { apiUrl } from '../api/client'
import type { SearchTree } from '../api/types'
import { createTree } from '../features/search/searchReducer'
import { db, DEMO_USER } from './db'
import { server } from './node'

// ---------- OpenAPI document (read-only, via a relative path like the validator fixture) ----------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = Record<string, Json>

interface OpenApiResponse {
  content?: Record<string, { schema?: JsonObject }>
}
interface OpenApiOperation {
  operationId?: string
  responses: Record<string, OpenApiResponse>
}
interface OpenApiDocument {
  openapi: string
  jsonSchemaDialect?: string
  paths: Record<string, Record<string, OpenApiOperation>>
  components: { schemas: Record<string, JsonObject> }
}

const specFiles = import.meta.glob<OpenApiDocument>('../../../backend/openapi.json', {
  eager: true,
  import: 'default',
})
const spec = Object.values(specFiles)[0]
if (!spec) throw new Error('backend/openapi.json not found')

const API_PREFIX = '/api/v1'
const BASE_ID = 'https://contract.test/openapi.json'
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const

const isObject = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Deep clone that (1) rewrites `#/components/schemas/X` refs to `BASE_ID#/$defs/X`
 * and (2) closes every object schema that lists `properties` but doesn't say
 * anything about extra properties: the backend's Pydantic response models never
 * emit unknown fields, so neither may the mocks.
 */
function strictClone(node: Json): Json {
  if (Array.isArray(node)) return node.map(strictClone)
  if (!isObject(node)) return node
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string')
      out[key] = value.replace('#/components/schemas/', `${BASE_ID}#/$defs/`)
    else if (key === 'properties' && isObject(value))
      // Property *names* are not schemas; only clone their values.
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictClone(v)]))
    else out[key] = strictClone(value)
  }
  if (
    isObject(out.properties) &&
    !('additionalProperties' in out) &&
    !('unevaluatedProperties' in out) &&
    !('patternProperties' in out)
  )
    out.additionalProperties = false
  return out
}

// OpenAPI 3.1 schemas are JSON Schema 2020-12 (unless a different dialect is declared).
expect(spec.openapi).toMatch(/^3\.1\./)
expect(spec.jsonSchemaDialect ?? 'https://json-schema.org/draft/2020-12/schema').toBe(
  'https://json-schema.org/draft/2020-12/schema',
)

const ajv = new Ajv2020({ allErrors: true, strict: true })
// ajv-formats is CJS; its default export lands on `.default` under some interop paths.
const addFormats =
  (addFormatsPlugin as unknown as { default?: typeof addFormatsPlugin }).default ?? addFormatsPlugin
addFormats(ajv)
// OpenAPI-only annotation keywords that are not part of JSON Schema 2020-12.
ajv.addVocabulary(['discriminator', 'example', 'xml', 'externalDocs'])
ajv.addSchema({ $id: BASE_ID, $defs: strictClone(spec.components.schemas) as JsonObject })

const validators = new Map<string, ValidateFunction>()
function validatorFor(schema: JsonObject): ValidateFunction {
  const key = JSON.stringify(schema)
  let fn = validators.get(key)
  if (!fn) {
    fn = ajv.compile(strictClone(schema) as JsonObject)
    validators.set(key, fn)
  }
  return fn
}

const errorOut = validatorFor({ $ref: '#/components/schemas/ErrorOut' })

interface Route {
  method: string
  template: string
  regex: RegExp
  operation: OpenApiOperation
}

const routes: Route[] = Object.entries(spec.paths).flatMap(([template, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({
    method: method.toUpperCase(),
    template,
    // Literal segments first so `/games/current` beats `/games/{game_id}`.
    regex: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`),
    operation: item[method]!,
  })),
)
routes.sort(
  (a, b) => (a.template.match(/\{/g)?.length ?? 0) - (b.template.match(/\{/g)?.length ?? 0),
)

function findRoute(method: string, path: string): Route | undefined {
  return routes.find((r) => r.method === method && r.regex.test(path))
}

/**
 * Statuses the backend can return although the OpenAPI document doesn't list them
 * for that operation. Bodies are then validated against `ErrorOut` directly.
 * Keep empty unless a real backend gap is documented in the report.
 */
const UNDECLARED_ERRORS: ReadonlySet<string> = new Set<string>()

// ---------- driving the mock API ----------

/** `METHOD template` -> statuses seen, for the coverage check at the end. */
const seen = new Map<string, Set<number>>()

interface Call {
  token?: string | null
  body?: unknown
}

interface Reply<T = Record<string, unknown>> {
  status: number
  body: T
}

/** Calls the MSW mock exactly like the app would and checks the reply against the contract. */
async function call<T = Record<string, unknown>>(
  method: string,
  pathAndQuery: string,
  { token, body }: Call = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(apiUrl(pathAndQuery), {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const where = `${method} ${pathAndQuery} -> ${res.status}`
  const path = API_PREFIX + pathAndQuery.split('?')[0]!
  const route = findRoute(method, path)
  if (!route) throw new Error(`${where}: no such operation in backend/openapi.json`)
  const key = `${method} ${route.template}`
  seen.set(key, (seen.get(key) ?? new Set()).add(res.status))

  expect(res.headers.get('content-type') ?? '', where).toMatch(/application\/json/)
  const parsed = JSON.parse(text) as Json

  const declared = route.operation.responses[String(res.status)]
  let validate: ValidateFunction
  if (declared) {
    const schema = declared.content?.['application/json']?.schema
    if (!schema) throw new Error(`${where}: no application/json schema declared`)
    validate = validatorFor(schema)
  } else if (UNDECLARED_ERRORS.has(`${key} ${res.status}`)) {
    validate = errorOut
  } else {
    throw new Error(
      `${where}: status not declared for ${key} (declared: ${Object.keys(route.operation.responses).join(', ')})`,
    )
  }
  if (!validate(parsed))
    throw new Error(
      `${where}: body does not match schema\n${ajv.errorsText(validate.errors)}\n${text}`,
    )
  // Every error the backend renders is `{detail, code}`, declared or not.
  if (res.status >= 400 && !errorOut(parsed))
    throw new Error(`${where}: error body is not ErrorOut\n${text}`)
  return { status: res.status, body: parsed as T }
}

async function expectError(reply: Promise<Reply>, status: number, code: string): Promise<Reply> {
  const r = await reply
  expect({ status: r.status, code: r.body.code }).toEqual({ status, code })
  return r
}

async function login(email = DEMO_USER.email, password = DEMO_USER.password): Promise<string> {
  const r = await call<{ access_token: string }>('POST', '/auth/login', {
    body: { email, password },
  })
  expect(r.status).toBe(200)
  return r.body.access_token
}

interface WireGame {
  id: number
  version: number
  givens: string
  current: string
}

async function newGame(token: string, difficulty = 'easy'): Promise<WireGame> {
  const r = await call<WireGame>('POST', '/games', { token, body: { difficulty } })
  expect(r.status).toBe(201)
  return r.body
}

const solutionOf = (id: number): string => {
  const game = db.games.find((g) => g.id === id)
  if (!game) throw new Error(`game ${id} missing`)
  return game.solution
}

// ---------- tests ----------

describe('MSW mocks follow backend/openapi.json', () => {
  it('auth: register -> verify -> login -> me -> refresh -> logout', async () => {
    expect((await call('GET', '/health')).status).toBe(200)

    const email = 'contract@example.com'
    const password = 'correct horse'
    const reg = await call('POST', '/auth/register', {
      body: { username: 'contract_user', email, password },
    })
    expect(reg.status).toBe(202)
    // Same 202 for an existing email (no enumeration).
    expect(
      (
        await call('POST', '/auth/register', {
          body: { username: 'contract_two', email, password },
        })
      ).status,
    ).toBe(202)

    await expectError(
      call('POST', '/auth/login', { body: { email, password } }),
      403,
      'email_not_verified',
    )
    expect((await call('POST', '/auth/resend-verification', { body: { email } })).status).toBe(202)

    const verifyToken = db.outbox
      .filter((m) => m.to === email && m.kind === 'verify_email')
      .at(-1)!.token
    expect(
      (await call('POST', '/auth/verify-email', { body: { token: verifyToken } })).status,
    ).toBe(200)
    await expectError(
      call('POST', '/auth/verify-email', { body: { token: verifyToken } }),
      400,
      'invalid_token',
    )

    const token = await login(email, password)
    const me = await call<{ username: string; stats: { games_started: number } }>('GET', '/me', {
      token,
    })
    expect(me.status).toBe(200)
    expect(me.body.username).toBe('contract_user')

    const refreshed = await call<{ access_token: string }>('POST', '/auth/refresh')
    expect(refreshed.status).toBe(200)
    expect((await call('GET', '/me', { token: refreshed.body.access_token })).status).toBe(200)

    expect(
      (await call('POST', '/auth/logout', { token: refreshed.body.access_token })).status,
    ).toBe(200)
    await expectError(call('POST', '/auth/refresh'), 401, 'invalid_token')
    await expectError(
      call('GET', '/me', { token: refreshed.body.access_token }),
      401,
      'invalid_token',
    )
  })

  it('password reset flow', async () => {
    expect(
      (await call('POST', '/auth/forgot-password', { body: { email: DEMO_USER.email } })).status,
    ).toBe(202)
    const resetToken = db.outbox.filter((m) => m.kind === 'reset_password').at(-1)!.token
    await expectError(
      call('POST', '/auth/reset-password', { body: { token: resetToken, new_password: 'short' } }),
      422,
      'validation_error',
    )
    expect(
      (
        await call('POST', '/auth/reset-password', {
          body: { token: resetToken, new_password: 'new password 1' },
        })
      ).status,
    ).toBe(200)
    await expectError(
      call('POST', '/auth/reset-password', {
        body: { token: resetToken, new_password: 'new password 2' },
      }),
      400,
      'invalid_token',
    )
    await login(DEMO_USER.email, 'new password 1')
  })

  it('game: new -> current -> PATCH (search_tree) -> hints -> check -> propagate -> complete', async () => {
    const token = await login()
    const game = await newGame(token)

    const current = await call<WireGame>('GET', '/games/current', { token })
    expect(current.status).toBe(200)
    expect(current.body.id).toBe(game.id)
    expect((await call('GET', `/games/${game.id}`, { token })).status).toBe(200)

    const tree: SearchTree = createTree(game.givens)
    const empty = [...game.givens].findIndex((c) => c === '0')
    const solution = solutionOf(game.id)
    const board = game.givens.slice(0, empty) + solution[empty]! + game.givens.slice(empty + 1)
    const patched = await call<WireGame & { search_tree: SearchTree | null }>(
      'PATCH',
      `/games/${game.id}`,
      {
        token,
        body: {
          current: board,
          notes: { [String(empty + 1)]: [1, 2] },
          elapsed_seconds: 42,
          version: game.version,
          search_tree: tree,
        },
      },
    )
    expect(patched.status).toBe(200)
    expect(patched.body.search_tree).toEqual(tree)
    let version = patched.body.version

    for (const stage of [1, 2, 3]) {
      const hint = await call<{ stage: number }>('POST', `/games/${game.id}/hint`, {
        token,
        body: { stage },
      })
      expect(hint.status).toBe(200)
      expect(hint.body.stage).toBe(stage)
    }

    // A wrong digit so the error-hint and check paths return data.
    const wrongAt = [...board].findIndex((c) => c === '0')
    const wrongDigit = solution[wrongAt] === '9' ? '1' : '9'
    const withMistake = board.slice(0, wrongAt) + wrongDigit + board.slice(wrongAt + 1)
    const saved = await call<WireGame>('PATCH', `/games/${game.id}`, {
      token,
      body: { current: withMistake, notes: {}, elapsed_seconds: 50, version },
    })
    version = saved.body.version
    expect(
      (await call('POST', `/games/${game.id}/hint`, { token, body: { stage: 1 } })).status,
    ).toBe(200)
    const check = await call<{ wrong_cells: number[] }>('POST', `/games/${game.id}/check`, {
      token,
      body: {},
    })
    expect(check.status).toBe(200)
    expect(check.body.wrong_cells).toEqual([wrongAt])

    // Propagate: the solution with two holes (two naked singles) ...
    const holes = [...game.givens].flatMap((c, i) => (c === '0' ? [i] : [])).slice(0, 2)
    const nearlySolved = [...solution].map((c, i) => (holes.includes(i) ? '0' : c)).join('')
    const prop = await call<{ placements: unknown[]; contradiction: unknown }>(
      'POST',
      `/games/${game.id}/search/propagate`,
      { token, body: { board: nearlySolved } },
    )
    expect(prop.status).toBe(200)
    expect(prop.body.placements).toHaveLength(2)
    // ... and a board with a duplicate in a row, so `contradiction` is an object.
    const row = (i: number) => Math.floor(i / 9)
    const freeCell = holes[0]!
    const givenInRow = [...game.givens].findIndex((c, i) => c !== '0' && row(i) === row(freeCell))
    expect(givenInRow).toBeGreaterThanOrEqual(0)
    const dupBoard = [...game.givens]
    dupBoard[freeCell] = game.givens[givenInRow]!
    const dead = await call<{ contradiction: unknown }>(
      'POST',
      `/games/${game.id}/search/propagate`,
      { token, body: { board: dupBoard.join('') } },
    )
    expect(dead.status).toBe(200)
    expect(dead.body.contradiction).not.toBeNull()

    await expectError(
      call('POST', `/games/${game.id}/complete`, { token, body: {} }),
      422,
      'board_not_solved',
    )
    const solved = await call<WireGame>('PATCH', `/games/${game.id}`, {
      token,
      body: { current: solution, notes: {}, elapsed_seconds: 120, version, search_tree: null },
    })
    expect(solved.status).toBe(200)
    const done = await call<{ status: string; score: number }>(
      'POST',
      `/games/${game.id}/complete`,
      { token, body: {} },
    )
    expect(done.status).toBe(200)
    expect(done.body.status).toBe('completed')

    // Finished game: no current game, no more writes.
    await expectError(call('GET', '/games/current', { token }), 404, 'not_found')
    await expectError(
      call('PATCH', `/games/${game.id}`, {
        token,
        body: {
          current: solution,
          notes: {},
          elapsed_seconds: 130,
          version: solved.body.version + 1,
        },
      }),
      409,
      'game_not_in_progress',
    )
    for (const [path, body] of [
      ['hint', { stage: 1 }],
      ['check', {}],
      ['complete', {}],
      ['search/propagate', { board: solution }],
    ] as const)
      await expectError(
        call('POST', `/games/${game.id}/${path}`, { token, body }),
        409,
        'game_not_in_progress',
      )

    // Scores and leaderboards.
    const scores = await call<{ best: unknown[]; history: unknown[] }>(
      'GET',
      '/scores/me?limit=10',
      {
        token,
      },
    )
    expect(scores.status).toBe(200)
    expect(scores.body.history).toHaveLength(1)
    expect((await call('GET', '/me', { token })).status).toBe(200)

    for (const query of ['', '?difficulty=easy&period=day&limit=5', '?period=week'])
      expect((await call('GET', `/leaderboard${query}`)).status).toBe(200)
    const mine = await call<{ rank: number | null; entry: unknown }>(
      'GET',
      '/leaderboard/me?difficulty=easy',
      { token },
    )
    expect(mine.status).toBe(200)
    expect(mine.body.rank).not.toBeNull()
    // No completed game at this difficulty: rank and entry are null.
    const none = await call<{ rank: number | null; entry: unknown }>(
      'GET',
      '/leaderboard/me?difficulty=extreme&period=day',
      { token },
    )
    expect(none.body.entry).toBeNull()
  })

  it('a game with no empty cell left returns no_hint_available', async () => {
    const token = await login()
    const game = await newGame(token, 'beginner')
    const solution = solutionOf(game.id)
    await call('PATCH', `/games/${game.id}`, {
      token,
      body: { current: solution, notes: {}, elapsed_seconds: 1, version: game.version },
    })
    await expectError(
      call('POST', `/games/${game.id}/hint`, { token, body: { stage: 1 } }),
      409,
      'no_hint_available',
    )
  })

  it('representative errors use declared statuses and the {detail, code} body', async () => {
    // 401: no token, bad token.
    for (const [method, path] of [
      ['GET', '/me'],
      ['POST', '/games'],
      ['GET', '/games/current'],
      ['GET', '/games/1'],
      ['PATCH', '/games/1'],
      ['POST', '/games/1/hint'],
      ['POST', '/games/1/check'],
      ['POST', '/games/1/complete'],
      ['POST', '/games/1/search/propagate'],
      ['GET', '/scores/me'],
      ['GET', '/leaderboard/me'],
    ] as const) {
      await expectError(
        call(method, path, { body: method === 'GET' ? undefined : {} }),
        401,
        'not_authenticated',
      )
      await expectError(
        call(method, path, { token: 'nope', body: method === 'GET' ? undefined : {} }),
        401,
        'invalid_token',
      )
    }

    // Auth errors.
    await expectError(
      call('POST', '/auth/login', { body: { email: DEMO_USER.email, password: 'wrong pass' } }),
      401,
      'invalid_credentials',
    )
    await expectError(
      call('POST', '/auth/register', {
        body: { username: 'x', email: 'not-an-email', password: '1' },
      }),
      422,
      'validation_error',
    )
    await expectError(
      call('POST', '/auth/register', {
        body: { username: 'admin', email: 'a@example.com', password: 'password123' },
      }),
      422,
      'username_not_allowed',
    )
    await expectError(
      call('POST', '/auth/register', {
        body: { username: DEMO_USER.username, email: 'b@example.com', password: 'password123' },
      }),
      409,
      'username_taken',
    )
    await expectError(
      call('POST', '/auth/resend-verification', { body: { email: 'nope' } }),
      422,
      'validation_error',
    )
    await expectError(
      call('POST', '/auth/forgot-password', { body: { email: 'nope' } }),
      422,
      'validation_error',
    )

    const token = await login()
    // 404s.
    await expectError(call('GET', '/games/current', { token }), 404, 'not_found')
    await expectError(call('GET', '/games/999999', { token }), 404, 'not_found')
    await expectError(
      call('POST', '/games/999999/hint', { token, body: { stage: 1 } }),
      404,
      'not_found',
    )
    await expectError(call('POST', '/games/999999/check', { token, body: {} }), 404, 'not_found')
    await expectError(call('POST', '/games/999999/complete', { token, body: {} }), 404, 'not_found')
    await expectError(
      call('POST', '/games/999999/search/propagate', { token, body: { board: '0'.repeat(81) } }),
      404,
      'not_found',
    )

    // 422 validation.
    // `game_id` is an integer path parameter.
    await expectError(call('GET', '/games/abc', { token }), 422, 'validation_error')
    for (const path of ['hint', 'check', 'complete', 'search/propagate'])
      await expectError(
        call('POST', `/games/abc/${path}`, { token, body: {} }),
        422,
        'validation_error',
      )
    await expectError(
      call('POST', '/games', { token, body: { difficulty: 'impossible' } }),
      422,
      'validation_error',
    )
    const game = await newGame(token)
    await expectError(
      call('POST', `/games/${game.id}/hint`, { token, body: { stage: 4 } }),
      422,
      'validation_error',
    )
    await expectError(
      call('POST', `/games/${game.id}/search/propagate`, { token, body: { board: 'abc' } }),
      422,
      'validation_error',
    )
    await expectError(
      call('PATCH', `/games/${game.id}`, {
        token,
        body: { current: 'abc', notes: {}, elapsed_seconds: 0, version: game.version },
      }),
      422,
      'validation_error',
    )
    const badTree = { ...createTree(game.givens), surprise: true }
    await expectError(
      call('PATCH', `/games/${game.id}`, {
        token,
        body: {
          current: game.givens,
          notes: {},
          elapsed_seconds: 0,
          version: game.version,
          search_tree: badTree,
        },
      }),
      422,
      'validation_error',
    )
    for (const query of ['?difficulty=nope', '?period=year', '?limit=0', '?limit=101'])
      await expectError(call('GET', `/leaderboard${query}`), 422, 'validation_error')
    await expectError(
      call('GET', '/leaderboard/me?period=year', { token }),
      422,
      'validation_error',
    )
    for (const query of ['?limit=0', '?limit=201', '?offset=-1', '?limit=abc'])
      await expectError(call('GET', `/scores/me${query}`, { token }), 422, 'validation_error')

    // 422 givens_modified (PATCH + propagate).
    const given = [...game.givens].findIndex((c) => c !== '0')
    const tampered =
      game.givens.slice(0, given) +
      (game.givens[given] === '1' ? '2' : '1') +
      game.givens.slice(given + 1)
    await expectError(
      call('PATCH', `/games/${game.id}`, {
        token,
        body: { current: tampered, notes: {}, elapsed_seconds: 0, version: game.version },
      }),
      422,
      'givens_modified',
    )
    await expectError(
      call('POST', `/games/${game.id}/search/propagate`, { token, body: { board: tampered } }),
      422,
      'givens_modified',
    )

    // 409 version_conflict.
    await expectError(
      call('PATCH', `/games/${game.id}`, {
        token,
        body: { current: game.givens, notes: {}, elapsed_seconds: 0, version: game.version + 5 },
      }),
      409,
      'version_conflict',
    )
  })

  it('every operation in backend/openapi.json was exercised with a 2xx response', () => {
    // 503 `puzzle_unavailable` (POST /games) and 503 /health are not reachable in
    // the mocks: they generate puzzles locally and have no database.
    const missing = routes
      .map((r) => `${r.method} ${r.template}`)
      .filter((key) => ![...(seen.get(key) ?? [])].some((s) => s >= 200 && s < 300))
    expect(missing).toEqual([])
  })
})

describe('the contract checker itself', () => {
  it('rejects unknown properties, even where the backend schema leaves them open', async () => {
    const token = await login()
    const game = (await newGame(token)) as unknown as Record<string, unknown>
    const gameOut = validatorFor({ $ref: '#/components/schemas/GameOut' })
    expect(gameOut(game)).toBe(true)
    expect(gameOut({ ...game, solution: '1'.repeat(81) })).toBe(false)
    // Nested objects are closed too.
    expect(gameOut({ ...game, hint_costs: { 1: 10, 2: 20, 3: 40, 4: 80 } })).toBe(false)
    expect(errorOut({ detail: 'x', code: 'y' })).toBe(true)
    expect(errorOut({ detail: 'x', code: 'y', status: 400 })).toBe(false)
    expect(errorOut({ detail: [{ msg: 'x' }], code: 'y' })).toBe(false)
  })

  it('rejects undeclared statuses and non-ErrorOut error bodies', async () => {
    server.use(
      http.get('*/api/v1/me', () => HttpResponse.json({ detail: 'x', code: 'y' }, { status: 418 })),
      http.get('*/api/v1/games/current', () =>
        HttpResponse.json({ detail: [{ loc: ['x'], msg: 'y' }] }, { status: 422 }),
      ),
    )
    await expect(call('GET', '/me')).rejects.toThrow(/status not declared/)
    await expect(call('GET', '/games/current')).rejects.toThrow(/does not match schema/)
    expect(findRoute('GET', '/api/v1/no/such/route')).toBeUndefined()
    expect(findRoute('GET', '/api/v1/games/current')?.template).toBe('/api/v1/games/current')
    expect(findRoute('GET', '/api/v1/games/7')?.template).toBe('/api/v1/games/{game_id}')
  })
})
