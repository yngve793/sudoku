import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { getSession, onSessionChange, refreshAccessToken } from '../../api/client'
import { authApi } from '../../api/endpoints'
import { AuthContext, type AuthContextValue, type AuthStatus } from './authContext'

const subscribe = (cb: () => void) => onSessionChange(cb)

/**
 * Session state. The access token and user live only in memory (api/client.ts);
 * on start-up we try a silent refresh using the httpOnly refresh cookie.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const session = useSyncExternalStore(subscribe, getSession, getSession)
  const [bootstrapped, setBootstrapped] = useState(() => getSession() !== null)

  useEffect(() => {
    if (bootstrapped) return
    let active = true
    void refreshAccessToken().finally(() => {
      if (active) setBootstrapped(true)
    })
    return () => {
      active = false
    }
  }, [bootstrapped])

  // Drop all cached private data when the session ends.
  useEffect(() => {
    if (session === null && bootstrapped) {
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'leaderboard' })
    }
  }, [session, bootstrapped, queryClient])

  const login = useCallback(async (identifier: string, password: string) => {
    await authApi.login({ email: identifier, password })
  }, [])

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } finally {
      queryClient.clear()
    }
  }, [queryClient])

  const status: AuthStatus = !bootstrapped
    ? 'loading'
    : session === null
      ? 'anonymous'
      : 'authenticated'

  const value = useMemo<AuthContextValue>(
    () => ({ status, user: session?.user ?? null, login, logout }),
    [status, session, login, logout],
  )
  return <AuthContext value={value}>{children}</AuthContext>
}
