import { QueryClient } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { authApi } from '../api/endpoints'
import { Providers } from '../app/Providers'
import { db, DEMO_USER, type MockGame } from '../mocks/db'
import { makePuzzle } from '../mocks/puzzles'
import { routes } from '../routes/routes'

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  })
}

/** Renders the whole app (real routes + providers) at `path`, backed by MSW. */
export function renderApp(path = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const client = createTestQueryClient()
  const user = userEvent.setup()
  const utils = render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  )
  return { ...utils, router, client, user }
}

/** Logs the demo user in through the mock API (sets the in-memory token). */
export async function loginAsDemo(): Promise<void> {
  await authApi.login({ email: DEMO_USER.email, password: DEMO_USER.password })
}

export function demoUserId(): number {
  const user = db.users.find((u) => u.email === DEMO_USER.email)
  if (!user) throw new Error('demo user missing')
  return user.id
}

/** Inserts an in-progress game for the demo user directly into the mock DB. */
export function seedGame(overrides: Partial<MockGame> = {}): MockGame {
  const puzzle = makePuzzle('easy', 42)
  const now = new Date().toISOString()
  const game: MockGame = {
    id: 9000 + db.games.length,
    user_id: demoUserId(),
    difficulty: 'easy',
    status: 'in_progress',
    givens: puzzle.givens,
    solution: puzzle.solution,
    current: puzzle.givens,
    notes: {},
    elapsed_seconds: 30,
    hints_used: 0,
    hint_stages: [],
    mistakes: 0,
    score: null,
    version: 1,
    started_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  }
  db.games.push(game)
  return game
}

export function firstEmptyIndex(game: Pick<MockGame, 'current'>, after = -1): number {
  for (let i = after + 1; i < 81; i++) if (game.current[i] === '0') return i
  throw new Error('no empty cell')
}

export function cellLabelPrefix(index: number): string {
  return `Row ${Math.floor(index / 9) + 1}, column ${(index % 9) + 1},`
}
