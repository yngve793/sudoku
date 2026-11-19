import { ApiError, request, setSession } from './client'
import type {
  CheckResponse,
  CompletedGame,
  Difficulty,
  Game,
  GameUpdateRequest,
  Hint,
  HintStage,
  Leaderboard,
  LeaderboardMe,
  LeaderboardPeriod,
  LoginRequest,
  PropagateResponse,
  Me,
  MessageResponse,
  RegisterRequest,
  ResetPasswordRequest,
  ScoresMe,
  TokenResponse,
} from './types'

const post = <T>(path: string, body?: unknown, auth = true) =>
  request<T>(path, { method: 'POST', body, auth })

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const authApi = {
  register: (body: RegisterRequest) => post<MessageResponse>('/auth/register', body, false),
  verifyEmail: (token: string) => post<MessageResponse>('/auth/verify-email', { token }, false),
  resendVerification: (email: string) =>
    post<MessageResponse>('/auth/resend-verification', { email }, false),
  forgotPassword: (email: string) =>
    post<MessageResponse>('/auth/forgot-password', { email }, false),
  resetPassword: (body: ResetPasswordRequest) =>
    post<MessageResponse>('/auth/reset-password', body, false),
  /** `email` may also be a username. Stores the token and user in memory. */
  login: async (body: LoginRequest): Promise<TokenResponse> => {
    const tokens = await post<TokenResponse>('/auth/login', body, false)
    setSession(tokens)
    return tokens
  },
  logout: async (): Promise<void> => {
    try {
      await post<MessageResponse>('/auth/logout', undefined, false)
    } finally {
      setSession(null)
    }
  },
  me: () => request<Me>('/me'),
}

export const gamesApi = {
  create: (difficulty: Difficulty) => post<Game>('/games', { difficulty }),
  /** Returns `null` when the user has no in-progress game (any 404). */
  current: async (): Promise<Game | null> => {
    try {
      return await request<Game>('/games/current')
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  },
  get: (id: number) => request<Game>(`/games/${id}`),
  save: (id: number, body: GameUpdateRequest, keepalive = false) =>
    request<Game>(`/games/${id}`, { method: 'PATCH', body, keepalive }),
  // Hint/check/complete evaluate the server's saved board; callers flush a PATCH first.
  hint: (id: number, stage: HintStage) => post<Hint>(`/games/${id}/hint`, { stage }),
  check: (id: number) => post<CheckResponse>(`/games/${id}/check`),
  complete: (id: number) => post<CompletedGame>(`/games/${id}/complete`),
  /** Search mode, auto implications for `board` (does not change `version`). */
  propagate: (id: number, board: string) =>
    post<PropagateResponse>(`/games/${id}/search/propagate`, { board }),
}

export const scoresApi = {
  mine: () => request<ScoresMe>('/scores/me'),
  /** `difficulty: null` = all difficulties. */
  leaderboard: (difficulty: Difficulty | null, period: LeaderboardPeriod, limit = 50) =>
    request<Leaderboard>(`/leaderboard${query({ difficulty, period, limit })}`, { auth: false }),
  leaderboardMe: (difficulty: Difficulty | null, period: LeaderboardPeriod) =>
    request<LeaderboardMe>(`/leaderboard/me${query({ difficulty, period })}`),
}
