import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client'
import { importsApi } from '../../api/endpoints'
import type { ImportCheck } from '../../api/types'
import { importTimings } from './importSession'

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

const isRateLimited = (error: unknown) => error instanceof ApiError && error.status === 429

export interface ImportCheckState {
  /** Latest result; may describe an earlier board while `stale`. */
  result: ImportCheck | null
  /** The result doesn't describe the board on screen yet (debouncing or loading). */
  stale: boolean
  rateLimited: boolean
  error: unknown
}

/** Debounced `POST /imports/check` for the reviewed board (live validation). */
export function useImportCheck(givens: string, current: string): ImportCheckState {
  const key = `${givens}:${current}`
  const debouncedKey = useDebounced(key, importTimings.checkDebounceMs)
  const [dGivens = '', dCurrent = ''] = debouncedKey.split(':')
  const query = useQuery({
    queryKey: ['imports', 'check', dGivens, dCurrent],
    queryFn: ({ signal }) => importsApi.check({ givens: dGivens, current: dCurrent }, signal),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 60_000,
    // 429: wait and retry a few times (the budget refills); other errors surface at once.
    retry: (count, error) => isRateLimited(error) && count < 5,
    retryDelay: () => importTimings.checkRetryMs,
  })
  const rateLimited = isRateLimited(query.failureReason) || isRateLimited(query.error)
  return {
    result: query.data ?? null,
    stale: debouncedKey !== key || query.isPlaceholderData || query.isFetching || !query.data,
    rateLimited,
    error: query.error,
  }
}
