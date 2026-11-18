import { useQuery } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError } from '../../api/client'
import { gamesApi } from '../../api/endpoints'
import { Alert } from '../../components/Alert'
import { Spinner } from '../../components/Spinner'
import { errorMessage } from '../../lib/errors'
import { GameSession } from './GameSession'
import { gameQueryKey } from './useStartGame'

export function GamePage() {
  const { gameId } = useParams()
  const id = Number(gameId)
  const valid = Number.isInteger(id) && id > 0
  const [conflicted, setConflicted] = useState(false)

  const query = useQuery({
    queryKey: gameQueryKey(id),
    queryFn: () => gamesApi.get(id),
    enabled: valid,
    // Always load the latest server state when opening a board.
    gcTime: 0,
    staleTime: Infinity,
  })
  const { refetch } = query

  const onConflict = useCallback(() => {
    setConflicted(true)
    void refetch()
  }, [refetch])

  if (!valid || (query.error instanceof ApiError && query.error.status === 404)) {
    return (
      <div className="page page--narrow">
        <Alert tone="error" title="Game not found">
          This game doesn&apos;t exist or belongs to someone else.
        </Alert>
        <Link to="/" className="button button--primary">
          Back to home
        </Link>
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="page page--narrow">
        <Alert tone="error">{errorMessage(query.error)}</Alert>
        <button type="button" className="button button--primary" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    )
  }
  if (!query.data) return <Spinner label="Loading game" />

  return (
    <GameSession
      key={`${query.data.id}:${query.dataUpdatedAt}`}
      game={query.data}
      conflictNotice={conflicted}
      onConflict={onConflict}
    />
  )
}
