import { createContext, useContext } from 'react'
import type { User } from '../../api/types'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export interface AuthContextValue {
  status: AuthStatus
  /** From the login/refresh response (no extra /me call needed). */
  user: User | null
  /** `identifier` is an email address or a username. */
  login: (identifier: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

/** /me: profile + stats, used by the dashboard. */
export const meQueryKey = ['me'] as const

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
