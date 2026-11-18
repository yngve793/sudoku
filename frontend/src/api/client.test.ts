import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../mocks/node'
import {
  ApiError,
  describeDetail,
  getAccessToken,
  getSession,
  isApiError,
  refreshAccessToken,
  request,
  setSession,
} from './client'
import type { TokenResponse } from './types'

const user = {
  id: 1,
  username: 'demo',
  email: 'demo@example.com',
  email_verified: true,
  created_at: '2026-01-01T00:00:00Z',
}
const tokens = (access_token: string): TokenResponse => ({
  access_token,
  token_type: 'bearer',
  expires_in: 900,
  user,
})

describe('request', () => {
  it('sends the bearer token and credentials: include', async () => {
    let seen: { auth: string | null; credentials: string } | null = null
    server.use(
      http.get('*/api/v1/ping', ({ request: req }) => {
        seen = { auth: req.headers.get('Authorization'), credentials: req.credentials }
        return HttpResponse.json({ ok: true })
      }),
    )
    setSession(tokens('abc'))
    await expect(request('/ping')).resolves.toEqual({ ok: true })
    expect(seen).toEqual({ auth: 'Bearer abc', credentials: 'include' })
  })

  it('omits the token for public calls', async () => {
    let auth: string | null = 'unset'
    server.use(
      http.get('*/api/v1/public', ({ request: req }) => {
        auth = req.headers.get('Authorization')
        return HttpResponse.json({})
      }),
    )
    setSession(tokens('abc'))
    await request('/public', { auth: false })
    expect(auth).toBeNull()
  })

  it('throws ApiError with status and code', async () => {
    server.use(
      http.get('*/api/v1/boom', () =>
        HttpResponse.json({ detail: 'Game not found', code: 'not_found' }, { status: 404 }),
      ),
    )
    const error = await request('/boom').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(isApiError(error, 'not_found')).toBe(true)
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).message).toBe('Game not found')
  })

  it('tolerates non-JSON error bodies (e.g. a proxy 502 page)', async () => {
    server.use(http.get('*/api/v1/proxy', () => new HttpResponse('Bad Gateway', { status: 502 })))
    const error = await request('/proxy').catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 502, code: undefined, message: 'Bad Gateway' })
  })

  it('returns null for 204', async () => {
    server.use(http.post('*/api/v1/empty', () => new HttpResponse(null, { status: 204 })))
    await expect(request('/empty', { method: 'POST' })).resolves.toBeNull()
  })

  it('refreshes silently on 401 and retries once', async () => {
    let refreshCalls = 0
    server.use(
      http.post('*/api/v1/auth/refresh', () => {
        refreshCalls++
        return HttpResponse.json(tokens('fresh'))
      }),
      http.get('*/api/v1/secret', ({ request: req }) =>
        req.headers.get('Authorization') === 'Bearer fresh'
          ? HttpResponse.json({ secret: 42 })
          : HttpResponse.json({ detail: 'expired' }, { status: 401 }),
      ),
    )
    setSession(tokens('stale'))
    const [a, b] = await Promise.all([request('/secret'), request('/secret')])
    expect(a).toEqual({ secret: 42 })
    expect(b).toEqual({ secret: 42 })
    expect(refreshCalls).toBe(1) // concurrent 401s share one refresh
    expect(getAccessToken()).toBe('fresh')
    expect(getSession()?.user.username).toBe('demo')
  })

  it('clears the token when refresh fails', async () => {
    server.use(
      http.post('*/api/v1/auth/refresh', () => HttpResponse.json({}, { status: 401 })),
      http.get('*/api/v1/secret', () => HttpResponse.json({ detail: 'x' }, { status: 401 })),
    )
    setSession(tokens('stale'))
    await expect(request('/secret')).rejects.toMatchObject({ status: 401 })
    expect(getAccessToken()).toBeNull()
  })

  it('keeps the session when refresh is rate limited (transient)', async () => {
    server.use(
      http.post('*/api/v1/auth/refresh', () =>
        HttpResponse.json({ detail: 'slow down', code: 'rate_limited' }, { status: 429 }),
      ),
    )
    setSession(tokens('current'))
    await expect(refreshAccessToken()).resolves.toBeNull()
    expect(getAccessToken()).toBe('current')
  })

  it('refreshAccessToken survives network errors', async () => {
    server.use(http.post('*/api/v1/auth/refresh', () => HttpResponse.error()))
    await expect(refreshAccessToken()).resolves.toBeNull()
  })
})

describe('describeDetail', () => {
  it('handles strings, validation lists and unknown shapes', () => {
    expect(describeDetail('x')).toBe('x')
    expect(describeDetail([{ msg: 'a' }, { msg: 'b' }, 3])).toBe('a. b')
    expect(describeDetail([])).toBeUndefined()
    expect(describeDetail({ nope: 1 })).toBeUndefined()
  })
})
