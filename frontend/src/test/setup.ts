import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { apiUrl, setSession } from '../api/client'
import { resetMockDb } from '../mocks/db'
import { server } from '../mocks/node'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(async () => {
  cleanup()
  server.resetHandlers()
  // MSW keeps mocked Set-Cookie values in its own cookie jar; the mock logout
  // endpoint expires the refresh cookie so sessions don't leak between tests.
  await fetch(apiUrl('/auth/logout'), { method: 'POST', credentials: 'include' })
  resetMockDb()
  setSession(null)
})
afterAll(() => server.close())
