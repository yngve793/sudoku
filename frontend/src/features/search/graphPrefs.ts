import { useCallback, useState } from 'react'
import type { GraphLayoutMode } from './graphLayout'

/** UI preference only; never part of the persisted search tree. */
export const GRAPH_LAYOUT_KEY = 'sudoku.searchGraph.layout'

function read(): GraphLayoutMode {
  try {
    return localStorage.getItem(GRAPH_LAYOUT_KEY) === 'expanded' ? 'expanded' : 'compact'
  } catch {
    return 'compact'
  }
}

export function useGraphLayoutPref(): [GraphLayoutMode, (mode: GraphLayoutMode) => void] {
  const [mode, setMode] = useState<GraphLayoutMode>(read)
  const update = useCallback((next: GraphLayoutMode) => {
    setMode(next)
    try {
      localStorage.setItem(GRAPH_LAYOUT_KEY, next)
    } catch {
      /* storage unavailable: keep it for this page only */
    }
  }, [])
  return [mode, update]
}
