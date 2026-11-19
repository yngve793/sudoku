import { useEffect, useReducer, useRef, useState } from 'react'
import { gamesApi } from '../../api/endpoints'
import type { Game } from '../../api/types'
import { errorMessage } from '../../lib/errors'
import { techniqueKey, type TechniqueMap } from './graphModel'
import { serializeGrid } from '../game/grid'
import {
  createSearchState,
  findNode,
  nodeBoard,
  searchReducer,
  type SearchState,
} from './searchReducer'

function init(game: Game): SearchState {
  return searchReducer(createSearchState(), { type: 'load', tree: game.search_tree })
}

/**
 * Search-mode state for one game: the pure tree reducer plus the auto-mode
 * side effect (drains `pending` by calling the propagate endpoint, one node at
 * a time) and the running auto-placement count.
 */
export function useSearch(game: Game, enabled: boolean) {
  const [state, dispatch] = useReducer(searchReducer, game, init)
  const [autoPlacements, setAutoPlacements] = useState(game.auto_placements)
  const [error, setError] = useState<string | null>(null)
  // Techniques of auto placements from this session's propagate responses.
  // UI-only: the persisted tree has no field for them (strict backend schema).
  const [techniques, setTechniques] = useState<TechniqueMap>(() => new Map())
  const inFlight = useRef<string | null>(null)

  const nextId = state.pending[0]
  useEffect(() => {
    if (nextId === undefined || inFlight.current !== null) return
    const tree = state.tree
    const node = tree ? findNode(tree, nextId) : undefined
    if (!tree || !node || !enabled || node.status !== 'open' || tree.mode !== 'auto') {
      dispatch({ type: 'autoDone', nodeId: nextId })
      return
    }
    inFlight.current = nextId
    const board = serializeGrid(nodeBoard(tree, nextId))
    gamesApi
      .propagate(game.id, board)
      .then((res) => {
        inFlight.current = null
        setError(null)
        setAutoPlacements(res.auto_placements)
        if (res.placements.length)
          setTechniques((prev) => {
            const next = new Map(prev)
            for (const p of res.placements)
              next.set(techniqueKey(nextId, p.cell, p.value), p.technique)
            return next
          })
        dispatch({
          type: 'autoResult',
          nodeId: nextId,
          placements: res.placements,
          contradiction: res.contradiction,
        })
      })
      .catch((err: unknown) => {
        inFlight.current = null
        setError(errorMessage(err))
        dispatch({ type: 'autoDone', nodeId: nextId })
      })
  }, [nextId, state.tree, enabled, game.id])

  return {
    state,
    dispatch,
    autoPlacements,
    /** Auto-mode propagation is queued or running. */
    propagating: state.pending.length > 0,
    error,
    techniques,
    clearError: () => setError(null),
  }
}
