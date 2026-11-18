import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { gamesApi } from '../../api/endpoints'
import type { Difficulty } from '../../api/types'

export const currentGameQueryKey = ['games', 'current'] as const
export const gameQueryKey = (id: number) => ['games', id] as const

/** POST /games then open the new board. Abandons any in-progress game server-side. */
export function useStartGame() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (difficulty: Difficulty) => gamesApi.create(difficulty),
    onSuccess: (game) => {
      queryClient.setQueryData(currentGameQueryKey, game)
      void navigate(`/game/${game.id}`)
    },
  })
}
