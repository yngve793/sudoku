import type { TokenResponse, User } from './types'

export const API_BASE = '/api/v1'

/** Absolute URL for an API path (absolute so it also works under jsdom/Node fetch). */
export function apiUrl(path: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}${API_BASE}${path}`
}

/** Error thrown for any non-2xx response. `code` mirrors the backend's `code` field. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly detail: unknown

  constructor(status: number, body: unknown) {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    super(describeDetail(record.detail) ?? `Request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.code = typeof record.code === 'string' ? record.code : undefined
    this.detail = record.detail
  }
}

/** Turns a FastAPI `detail` (string or validation-error list) into readable text. */
export function describeDetail(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item: unknown) =>
        item && typeof item === 'object' && 'msg' in item ? String(item.msg) : null,
      )
      .filter((m): m is string => m !== null)
    return messages.length ? messages.join('. ') : undefined
  }
  return undefined
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code)
}

// ---------- session: memory only (never localStorage) ----------

export interface Session {
  accessToken: string
  user: User
}

let session: Session | null = null
type SessionListener = (session: Session | null) => void
const listeners = new Set<SessionListener>()

export function getSession(): Session | null {
  return session
}

export function getAccessToken(): string | null {
  return session?.accessToken ?? null
}

/** Stores the login/refresh response in memory, or clears it with `null`. */
export function setSession(tokens: TokenResponse | null): void {
  const next = tokens ? { accessToken: tokens.access_token, user: tokens.user } : null
  if (next?.accessToken === session?.accessToken && next?.user === session?.user) return
  session = next
  listeners.forEach((listener) => listener(session))
}

export function onSessionChange(listener: SessionListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---------- refresh (deduplicated) ----------

let refreshInFlight: Promise<string | null> | null = null

/**
 * Exchanges the httpOnly refresh cookie for a new access token.
 * Concurrent callers share one request so the rotating token is used once.
 */
export function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(apiUrl('/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        // Only 401 means the refresh cookie is gone/invalid. A 429 or 5xx is
        // transient, so keep whatever session we have and let the caller fail.
        if (res.status === 401) setSession(null)
        return null
      }
      const body = (await res.json()) as TokenResponse
      setSession(body)
      return body.access_token
    } catch {
      // Network error: transient, keep the session.
      return null
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

// ---------- request ----------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  /** Attach the bearer token and retry once after a silent refresh on 401. Default true. */
  auth?: boolean
  signal?: AbortSignal
  /** Let the request outlive the page (used for flush-on-unload autosave). */
  keepalive?: boolean
}

async function send(path: string, options: RequestOptions, token: string | null) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(apiUrl(path), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'include',
    signal: options.signal,
    keepalive: options.keepalive,
  })
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { detail: text }
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const useAuth = options.auth ?? true
  let res = await send(path, options, useAuth ? getAccessToken() : null)

  if (res.status === 401 && useAuth) {
    const token = await refreshAccessToken()
    if (token) res = await send(path, options, token)
  }

  const body = await parseBody(res)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

// ---------- multipart upload with progress (XHR: fetch has no upload progress) ----------

export interface UploadOptions {
  /** Upload progress 0..1 (only while the body is being sent). */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

function abortError(): DOMException {
  return new DOMException('The upload was cancelled.', 'AbortError')
}

function sendForm(
  path: string,
  makeBody: () => FormData,
  token: string | null,
  options: UploadOptions,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError())
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(path))
    xhr.withCredentials = true
    xhr.setRequestHeader('Accept', 'application/json')
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    // Reject at once on cancel; don't rely on every XHR implementation firing `abort`.
    function onAbort() {
      settle(() => reject(abortError()))
      xhr.abort()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        options.onProgress?.(Math.min(1, event.loaded / event.total))
    }
    xhr.onload = () => {
      let body: unknown = null
      const text = xhr.responseText
      if (text) {
        try {
          body = JSON.parse(text) as unknown
        } catch {
          body = { detail: text }
        }
      }
      settle(() => resolve({ status: xhr.status, body }))
    }
    xhr.onerror = () => settle(() => reject(new TypeError('Network request failed')))
    xhr.onabort = () => settle(() => reject(abortError()))
    // The browser sets the multipart Content-Type (with boundary) itself.
    xhr.send(makeBody())
  })
}

/**
 * POSTs `multipart/form-data` with the bearer token, reporting upload progress.
 * Like `request`, retries once after a silent refresh on 401. Aborting the
 * signal rejects with a DOMException named "AbortError".
 */
export async function uploadForm<T>(
  path: string,
  makeBody: () => FormData,
  options: UploadOptions = {},
): Promise<T> {
  let res = await sendForm(path, makeBody, getAccessToken(), options)
  if (res.status === 401) {
    const token = await refreshAccessToken()
    if (token) res = await sendForm(path, makeBody, token, options)
  }
  if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, res.body)
  return res.body as T
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
