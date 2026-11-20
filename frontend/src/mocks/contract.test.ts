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
import type { ImportCheck, Recognition, SearchTree } from '../api/types'
import { createTree } from '../features/search/searchReducer'
import { findContradiction } from '../features/search/constraints'
import { db, DEMO_USER } from './db'
import {
  HANDWRITTEN_READ,
  IMPORT_GIVENS,
  IMPORT_SOLUTION,
  MISREAD_CELL,
  MISREAD_TRUE_DIGIT,
  simulateImportError,
} from './imports'
import { server } from './node'
import { fakeJpeg, fakePng } from '../test/images'

// ---------- OpenAPI document (read-only, via a relative path like the validator fixture) ----------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = Record<string, Json>

interface OpenApiResponse {
  content?: Record<string, { schema?: JsonObject }>
}
interface OpenApiOperation {
  operationId?: string
  requestBody?: { content?: Record<string, { schema?: JsonObject }> }
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
  /** multipart/form-data body (checked against the operation's declared form schema). */
  form?: FormData
}

function resolveSchema(schema: JsonObject | undefined): JsonObject | undefined {
  const ref = schema?.$ref
  if (typeof ref !== 'string') return schema
  return spec?.components.schemas[ref.replace('#/components/schemas/', '')]
}

/**
 * The mocks receive exactly what the app sends, so check the app's multipart
 * body against the declared form schema: required fields present, no unknown
 * fields, binary fields are files and the rest are strings.
 */
function checkMultipart(route: Route, form: FormData, where: string): void {
  const schema = resolveSchema(
    route.operation.requestBody?.content?.['multipart/form-data']?.schema,
  )
  if (!schema) throw new Error(`${where}: operation declares no multipart/form-data body`)
  const props = isObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const name of required)
    if (typeof name === 'string' && !form.has(name))
      throw new Error(`${where}: multipart field "${name}" is required`)
  for (const [name, value] of form.entries()) {
    const prop = props[name]
    if (!isObject(prop)) throw new Error(`${where}: multipart field "${name}" is not declared`)
    const binary = prop.contentMediaType !== undefined || prop.format === 'binary'
    if (binary !== (typeof value !== 'string'))
      throw new Error(`${where}: multipart field "${name}" should be ${binary ? 'a file' : 'text'}`)
  }
}

interface Reply<T = Record<string, unknown>> {
  status: number
  body: T
}

/** Calls the MSW mock exactly like the app would and checks the reply against the contract. */
async function call<T = Record<string, unknown>>(
  method: string,
  pathAndQuery: string,
  { token, body, form }: Call = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const path = API_PREFIX + pathAndQuery.split('?')[0]!
  const route = findRoute(method, path)
  if (!route)
    throw new Error(`${method} ${pathAndQuery}: no such operation in backend/openapi.json`)
  if (form) checkMultipart(route, form, `${method} ${pathAndQuery}`)
  const res = await fetch(apiUrl(pathAndQuery), {
    method,
    headers,
    credentials: 'include',
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
  const text = await res.text()
  const where = `${method} ${pathAndQuery} -> ${res.status}`
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

// ---------- photo-import helpers ----------

function photoForm(file: Blob, corners?: string): FormData {
  const form = new FormData()
  form.append('file', file, 'photo.jpg')
  if (corners !== undefined) form.append('corners', corners)
  return form
}

function setCell(grid: string, index: number, digit: number): string {
  return grid.slice(0, index) + String(digit) + grid.slice(index + 1)
}

/** The import puzzle plus one wrong but locally legal given: consistent, yet unsolvable. */
function noSolutionGivens(): string {
  for (let i = 0; i < 81; i++) {
    if (IMPORT_GIVENS[i] !== '0') continue
    for (let d = 1; d <= 9; d++) {
      if (String(d) === IMPORT_SOLUTION[i]) continue
      const grid = setCell(IMPORT_GIVENS, i, d)
      if (!findContradiction([...grid].map(Number))) return grid
    }
  }
  throw new Error('no candidate found')
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
      ['POST', '/imports/check'],
      ['POST', '/games/import'],
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

  it('photo import: recognize (multipart) -> check -> games/import', async () => {
    // 401 on the multipart endpoint.
    await expectError(
      call('POST', '/imports/recognize', { form: photoForm(fakeJpeg(1200, 900)) }),
      401,
      'not_authenticated',
    )
    await expectError(
      call('POST', '/imports/recognize', { token: 'nope', form: photoForm(fakeJpeg(1200, 900)) }),
      401,
      'invalid_token',
    )
    const token = await login()

    const rec = await call<Recognition>('POST', '/imports/recognize', {
      token,
      form: photoForm(fakeJpeg(1200, 900)),
    })
    expect(rec.status).toBe(200)
    expect(rec.body.image_size).toEqual({ width: 1200, height: 900 })
    expect(rec.body.cells).toHaveLength(81)
    expect(rec.body.cells.some((c) => c.auto_corrected)).toBe(true)
    expect(rec.body.cells.some((c) => c.kind === 'handwritten' && c.confidence < 0.8)).toBe(true)
    // Corners round-trip: the client sends back what it received.
    const again = await call<Recognition>('POST', '/imports/recognize', {
      token,
      form: photoForm(fakeJpeg(1200, 900), JSON.stringify(rec.body.corners)),
    })
    expect(again.status).toBe(200)
    expect(again.body.corners).toEqual(rec.body.corners)
    // PNG and WebP are accepted too.
    expect(
      (await call('POST', '/imports/recognize', { token, form: photoForm(fakePng(640, 480)) }))
        .status,
    ).toBe(200)

    // Declared errors.
    await expectError(
      call('POST', '/imports/recognize', {
        token,
        form: photoForm(fakeJpeg(1200, 900), '[[1,2],[3,4]]'),
      }),
      422,
      'validation_error',
    )
    const noFile = new FormData()
    noFile.append('corners', '[[0,0],[1,0],[1,1],[0,1]]')
    await expect(call('POST', '/imports/recognize', { token, form: noFile })).rejects.toThrow(
      /"file" is required/,
    )
    await expectError(
      call('POST', '/imports/recognize', {
        token,
        form: photoForm(new Blob(['hello'], { type: 'text/plain' })),
      }),
      415,
      'unsupported_image',
    )
    await expectError(
      call('POST', '/imports/recognize', {
        token,
        form: photoForm(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/jpeg' })),
      }),
      413,
      'image_too_large',
    )
    await expectError(
      call('POST', '/imports/recognize', {
        token,
        form: photoForm(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00, 1, 2, 3])])),
      }),
      422,
      'image_unreadable',
    )
    await expectError(
      call('POST', '/imports/recognize', {
        token,
        form: photoForm(fakeJpeg(1200, 900), '[[10,10],[11,10],[11,11],[10,11]]'),
      }),
      422,
      'no_grid_found',
    )
    for (const [status, code] of [
      [429, 'rate_limited'],
      [503, 'recognition_unavailable'],
    ] as const) {
      simulateImportError('recognize', { status, code })
      await expectError(
        call('POST', '/imports/recognize', { token, form: photoForm(fakeJpeg(100, 100)) }),
        status,
        code,
      )
    }
    simulateImportError('recognize', null)

    // Check: givens decide the solution count; `current` decides consistency.
    const readCurrent = [...IMPORT_GIVENS]
      .map((g, i) => (g !== '0' ? g : String(HANDWRITTEN_READ[i] ?? 0)))
      .join('')
    const misread = await call<ImportCheck>('POST', '/imports/check', {
      token,
      body: { givens: IMPORT_GIVENS, current: readCurrent },
    })
    expect(misread.status).toBe(200)
    expect(misread.body).toMatchObject({ consistent: false, solution_count: 1 })
    expect(misread.body.contradiction?.cells).toContain(MISREAD_CELL)
    const fixed = setCell(readCurrent, MISREAD_CELL, MISREAD_TRUE_DIGIT)
    const ok = await call<ImportCheck>('POST', '/imports/check', {
      token,
      body: { givens: IMPORT_GIVENS, current: fixed },
    })
    expect(ok.body).toMatchObject({ consistent: true, contradiction: null, solution_count: 1 })
    expect(ok.body.rating_score).not.toBeNull()
    const sparse = IMPORT_GIVENS.slice(0, 27) + '0'.repeat(54)
    const many = await call<ImportCheck>('POST', '/imports/check', {
      token,
      body: { givens: sparse, current: sparse },
    })
    expect(many.body).toMatchObject({ solution_count: 2, difficulty: null, rating_score: null })
    const unsolvable = noSolutionGivens()
    const none = await call<ImportCheck>('POST', '/imports/check', {
      token,
      body: { givens: unsolvable, current: unsolvable },
    })
    expect(none.body).toMatchObject({ consistent: true, solution_count: 0 })
    await expectError(
      call('POST', '/imports/check', { token, body: { givens: 'abc', current: IMPORT_GIVENS } }),
      422,
      'validation_error',
    )
    const tampered = setCell(IMPORT_GIVENS, 0, 9)
    await expectError(
      call('POST', '/imports/check', { token, body: { givens: IMPORT_GIVENS, current: tampered } }),
      422,
      'givens_modified',
    )
    simulateImportError('check', { status: 429, code: 'rate_limited' })
    await expectError(
      call('POST', '/imports/check', { token, body: { givens: IMPORT_GIVENS, current: fixed } }),
      429,
      'rate_limited',
    )
    simulateImportError('check', null)

    // Import.
    const dup = setCell(IMPORT_GIVENS, 2, 5)
    for (const [givens, code] of [
      [dup, 'puzzle_inconsistent'],
      [unsolvable, 'no_solution'],
      [sparse, 'multiple_solutions'],
    ] as const)
      await expectError(
        call('POST', '/games/import', { token, body: { givens, current: givens } }),
        422,
        code,
      )
    await expectError(
      call('POST', '/games/import', { token, body: { givens: IMPORT_GIVENS, current: tampered } }),
      422,
      'givens_modified',
    )
    await expectError(
      call('POST', '/games/import', { token, body: { givens: IMPORT_GIVENS } }),
      422,
      'validation_error',
    )
    simulateImportError('import', { status: 429, code: 'rate_limited' })
    await expectError(
      call('POST', '/games/import', { token, body: { givens: IMPORT_GIVENS, current: fixed } }),
      429,
      'rate_limited',
    )
    simulateImportError('import', null)
    const generated = await newGame(token)
    const created = await call<WireGame & { source: string; difficulty: string | null }>(
      'POST',
      '/games/import',
      { token, body: { givens: IMPORT_GIVENS, current: fixed } },
    )
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      source: 'imported',
      givens: IMPORT_GIVENS,
      current: fixed,
    })
    // It abandoned the generated game and is now the current one.
    const cur = await call<WireGame>('GET', '/games/current', { token })
    expect(cur.body.id).toBe(created.body.id)
    expect(db.games.find((g) => g.id === generated.id)?.status).toBe('abandoned')

    // Finish it: in stats and history, never on the leaderboard.
    const solved = await call<WireGame>('PATCH', `/games/${created.body.id}`, {
      token,
      body: {
        current: IMPORT_SOLUTION,
        notes: {},
        elapsed_seconds: 60,
        version: created.body.version,
      },
    })
    expect(solved.status).toBe(200)
    const done = await call<{ score: number }>('POST', `/games/${created.body.id}/complete`, {
      token,
      body: {},
    })
    expect(done.status).toBe(200)
    const scores = await call<{ history: { game_id: number; source: string }[] }>(
      'GET',
      '/scores/me',
      { token },
    )
    expect(scores.body.history.find((h) => h.game_id === created.body.id)?.source).toBe('imported')
    const me = await call<{ rank: number | null; total: number }>('GET', '/leaderboard/me', {
      token,
    })
    expect(me.body.rank).toBeNull()

    // An Unrated imported game serialises `difficulty: null`.
    const game = db.games.find((g) => g.id === created.body.id)!
    game.difficulty = null
    const unrated = await call<{ difficulty: string | null }>('GET', `/games/${game.id}`, { token })
    expect(unrated.body.difficulty).toBeNull()
    const history = await call<{ history: { difficulty: string | null }[] }>('GET', '/scores/me', {
      token,
    })
    expect(history.body.history.some((h) => h.difficulty === null)).toBe(true)
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
