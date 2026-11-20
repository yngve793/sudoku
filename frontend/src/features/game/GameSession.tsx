import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { isApiError } from '../../api/client'
import { gamesApi } from '../../api/endpoints'
import type { Game, Hint, HintStage, ScoreBreakdown } from '../../api/types'
import { Alert } from '../../components/Alert'
import { GameBadges } from '../../components/GameBadges'
import { errorMessage } from '../../lib/errors'
import { describeDuration, formatDuration } from '../../lib/format'
import { SearchPanel } from '../search/SearchPanel'
import {
  MAX_NODES,
  canApply,
  cellMarks,
  childrenOf,
  nodeBoard,
  nodeBoardAt,
  nodeLabel,
  pathEntries,
  selectedNode,
  toWireTree,
  type SearchAction,
} from '../search/searchReducer'
import { candidates, findContradiction } from '../search/constraints'
import { selectedItemKey } from '../search/graphModel'
import { useSearch } from '../search/useSearch'
import { useSearchSyncHost } from '../search/useSearchSyncHost'
import type { SnapshotInput, SnapshotUi, SyncCommand } from '../search/sync'
import { Board, type BoardSearchMarks } from './Board'
import { CompletionDialog } from './CompletionDialog'
import { Controls } from './Controls'
import {
  canRedo,
  canUndo,
  createInitialState,
  gameReducer,
  isBoardComplete,
  type GameState,
} from './gameReducer'
import { cellName, digitCounts, emptyNotes, serializeGrid } from './grid'
import { HintPanel } from './HintPanel'
import { hintCost } from './hints'
import { keyToCommand } from './keyboard'
import { NumberPad } from './NumberPad'
import { useAutosave, type SaveStatus } from './useAutosave'
import { currentGameQueryKey, useStartGame } from './useStartGame'
import { useTimer } from './useTimer'

interface GameSessionProps {
  game: Game
  /** Shown once after reloading because of a version conflict. */
  conflictNotice: boolean
  onConflict: () => void
}

function init(game: Game): GameState {
  return gameReducer(createInitialState(), {
    type: 'load',
    givens: game.givens,
    current: game.current,
    notes: game.notes,
    locked: game.status !== 'in_progress',
  })
}

const NO_NOTES = emptyNotes()

const SAVE_TEXT: Record<SaveStatus, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved, retrying',
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function GameSession({ game, conflictNotice, onConflict }: GameSessionProps) {
  const queryClient = useQueryClient()
  const startGame = useStartGame()
  const [state, dispatch] = useReducer(gameReducer, game, init)
  const [status, setStatus] = useState(game.status)
  const [hintsUsed, setHintsUsed] = useState(game.hints_used)
  const [mistakes, setMistakes] = useState(game.mistakes)
  const [paused, setPaused] = useState(false)
  const [notice, setNotice] = useState<{
    tone: 'info' | 'warning' | 'error' | 'success'
    text: string
  } | null>(
    conflictNotice
      ? {
          tone: 'warning',
          text: 'This game was changed in another tab or device. We loaded the latest saved version.',
        }
      : null,
  )
  const [announcement, setAnnouncement] = useState('')
  const [result, setResult] = useState<{
    score: number
    elapsed: number
    breakdown: ScoreBreakdown | null
  } | null>(
    game.status === 'completed' && game.score !== null
      ? { score: game.score, elapsed: game.elapsed_seconds, breakdown: null }
      : null,
  )
  const [showResult, setShowResult] = useState(false)

  // Hint state; a hint is stale once the board changes after it was given.
  const [hintOpen, setHintOpen] = useState(false)
  const [hint, setHint] = useState<{ data: Hint; revision: number } | null>(null)
  const [hintPending, setHintPending] = useState(false)
  const [hintError, setHintError] = useState<string | null>(null)
  const activeHint = hint?.revision === state.revision ? hint.data : null

  const [checking, setChecking] = useState(false)
  const completingRef = useRef<number | null>(null)

  const playing = status === 'in_progress'
  const timer = useTimer(game.elapsed_seconds, playing && !paused)

  // Search mode (PLAN.md §5.5).
  const search = useSearch(game, playing)
  const searchTree = search.state.tree
  // Graph selection of an implication step (UI-only; the persisted tree only
  // knows the tree node). `null` = the end of the selected node's chain.
  const [viewStep, setViewStep] = useState<{ nodeId: string; step: number } | null>(null)
  const rawSearchDispatch = search.dispatch
  // Board actions apply to the node's full state, then selection jumps to the
  // end of its chain.
  const searchDispatch = useCallback(
    (action: SearchAction) => {
      if (action.type !== 'select' && action.type !== 'setMode') setViewStep(null)
      rawSearchDispatch(action)
    },
    [rawSearchDispatch],
  )
  const [searchActive, setSearchActive] = useState(false)
  const [guessPending, setGuessPending] = useState(false)
  const [searchMessage, setSearchMessage] = useState<string | null>(null)
  const inSearch = searchActive && searchTree !== null && playing
  const searchNode = inSearch ? selectedNode(search.state) : null
  const step =
    searchNode &&
    viewStep?.nodeId === searchNode.id &&
    !searchNode.collapsed &&
    viewStep.step < searchNode.placements.length - 1
      ? viewStep.step
      : null
  const selectedKey = searchNode ? selectedItemKey(searchNode, step) : ''
  const autosave = useAutosave({
    gameId: game.id,
    initialVersion: game.version,
    initialElapsed: game.elapsed_seconds,
    state,
    dispatch,
    elapsedRef: timer.elapsedRef,
    enabled: playing,
    onConflict,
    search: { tree: searchTree, revision: search.state.revision },
    onSearchTreeRejected: () =>
      setNotice({
        tone: 'warning',
        text: "Your search tree couldn't be saved, so it only lasts until you leave this page. The board itself is still saved. Reset the tree to try saving it again.",
      }),
  })
  const { flush, allowSearchTree } = autosave

  const interactive = playing && !paused

  // In search mode the board shows the selected node's board (read-only main board).
  const nodeCells = useMemo(
    () => (inSearch ? nodeBoard(searchTree, searchTree.selected_node_id) : null),
    [inSearch, searchTree],
  )
  // The board shows the node's state up to the selected step.
  const shownCells = useMemo(
    () =>
      inSearch && step !== null
        ? nodeBoardAt(searchTree, searchTree.selected_node_id, step)
        : nodeCells,
    [inSearch, searchTree, step, nodeCells],
  )
  const stepCell =
    searchNode && step !== null
      ? step < 0
        ? (searchNode.choice?.cell ?? null)
        : (searchNode.placements[step]?.cell ?? null)
      : null
  const displayState = useMemo<GameState>(
    () =>
      shownCells
        ? {
            ...state,
            cells: shownCells,
            notes: NO_NOTES,
            wrongCells: [],
            hintCells: [],
            notesMode: false,
          }
        : state,
    [shownCells, state],
  )
  const searchMarks = useMemo<BoardSearchMarks | undefined>(
    () =>
      inSearch
        ? {
            origins: cellMarks(searchTree, searchTree.selected_node_id, step),
            contradiction: new Set(
              (step === null ? searchNode?.contradiction : findContradiction(shownCells ?? []))
                ?.cells ?? [],
            ),
            stepCell,
          }
        : undefined,
    [inSearch, searchTree, searchNode, step, shownCells, stepCell],
  )
  const cellCandidates = useMemo(
    () => (nodeCells && state.selected !== null ? candidates(nodeCells, state.selected) : []),
    [nodeCells, state.selected],
  )
  const counts = useMemo(() => digitCounts(displayState.cells), [displayState.cells])

  const select = useCallback((index: number) => dispatch({ type: 'select', index }), [])

  const revealHint = useCallback(
    async (stage: HintStage) => {
      setHintOpen(true)
      setHintPending(true)
      setHintError(null)
      try {
        await flush()
        const data = await gamesApi.hint(game.id, stage)
        setHint({ data, revision: state.revision })
        dispatch({ type: 'setHintCells', cells: data.cells })
        setHintsUsed((n) => n + 1)
        setAnnouncement(`Hint: ${data.explanation}`)
      } catch (error) {
        setHintError(errorMessage(error))
      } finally {
        setHintPending(false)
      }
    },
    [flush, game.id, state.revision],
  )

  const onHintKey = useCallback(() => {
    if (!hintOpen) {
      setHintOpen(true)
      return
    }
    if (hintPending) return
    const stage = activeHint?.stage ?? 0
    if (stage < 3) void revealHint((stage + 1) as HintStage)
  }, [hintOpen, hintPending, activeHint, revealHint])

  const closeHint = useCallback(() => {
    setHintOpen(false)
    dispatch({ type: 'setHintCells', cells: [] })
  }, [])

  const check = useCallback(async () => {
    setChecking(true)
    try {
      await flush()
      const res = await gamesApi.check(game.id)
      dispatch({ type: 'markWrong', cells: res.wrong_cells })
      setMistakes(res.mistakes)
      const n = res.wrong_cells.length
      const text =
        n === 0
          ? 'No mistakes so far. Keep going!'
          : `${n} incorrect ${n === 1 ? 'cell is' : 'cells are'} marked with ✕: ${res.wrong_cells.map(cellName).join(', ')}.`
      setNotice({ tone: n === 0 ? 'success' : 'warning', text })
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) })
    } finally {
      setChecking(false)
    }
  }, [flush, game.id])

  // When the board is full and conflict-free, let the server verify it.
  useEffect(() => {
    if (!playing || !isBoardComplete(state) || completingRef.current === state.revision) return
    completingRef.current = state.revision
    void (async () => {
      try {
        await flush()
        const res = await gamesApi.complete(game.id)
        dispatch({ type: 'lock' })
        setStatus('completed')
        setHintOpen(false)
        setHintsUsed(res.hints_used)
        setMistakes(res.mistakes)
        setResult({
          score: res.score ?? res.score_breakdown.total,
          elapsed: res.elapsed_seconds,
          breakdown: res.score_breakdown,
        })
        setShowResult(true)
        setNotice(null)
        void queryClient.invalidateQueries({ queryKey: ['me'] })
        void queryClient.invalidateQueries({ queryKey: ['scores'] })
        void queryClient.invalidateQueries({ queryKey: ['leaderboard'] })
        queryClient.setQueryData(currentGameQueryKey, null)
      } catch (error) {
        setNotice(
          isApiError(error, 'board_not_solved')
            ? {
                tone: 'warning',
                text: "The board is full, but something isn't right. Use Check to find the mistakes.",
              }
            : { tone: 'error', text: errorMessage(error) },
        )
      }
    })()
  }, [state, playing, flush, game.id, queryClient])

  const enterSearch = useCallback(() => {
    if (!searchTree) searchDispatch({ type: 'create', rootBoard: serializeGrid(state.cells) })
    setSearchActive(true)
    setHintOpen(false)
    dispatch({ type: 'setHintCells', cells: [] })
    dispatch({ type: 'setNotesMode', value: false })
    setAnnouncement('Search mode on. The main board is read-only until you exit.')
  }, [searchTree, searchDispatch, state.cells])

  const exitSearch = useCallback(() => {
    setSearchActive(false)
    setGuessPending(false)
    setSearchMessage(null)
    setAnnouncement('Search mode off. Your tree is kept.')
  }, [])

  const searchGuess = useCallback(
    (digit: number) => {
      setGuessPending(false)
      if (!searchTree || !searchNode) return
      const cell = state.selected
      if (cell === null || nodeCells?.[cell] !== 0) {
        setSearchMessage('Select an empty cell to guess.')
        return
      }
      if (searchNode.status === 'dead') {
        setSearchMessage('This branch is dead. Select a live node to guess from.')
        return
      }
      const exists = childrenOf(searchTree, searchNode.id).some(
        (c) => c.choice?.cell === cell && c.choice.value === digit,
      )
      if (!exists && searchTree.nodes.length >= MAX_NODES) {
        setSearchMessage(`The tree is full (${MAX_NODES} nodes). Delete a branch first.`)
        return
      }
      setSearchMessage(null)
      searchDispatch({ type: 'guess', cell, value: digit })
      setAnnouncement(`New branch ${cellName(cell)} equals ${digit}.`)
    },
    [searchTree, searchNode, state.selected, nodeCells, searchDispatch],
  )

  const searchDigit = useCallback(
    (digit: number) => {
      // The root holds no placements: a digit there starts a guess instead.
      if (guessPending || searchNode?.parent_id === null) {
        searchGuess(digit)
        return
      }
      const cell = state.selected
      if (cell === null) return
      setSearchMessage(null)
      searchDispatch({ type: 'place', cell, value: digit })
    },
    [guessPending, searchNode, searchGuess, state.selected, searchDispatch],
  )

  const searchBranch = useCallback(() => {
    if (!searchTree || !searchNode) return
    const cell = state.selected
    if (cell === null || cellCandidates.length === 0) {
      setSearchMessage('Select an empty cell to branch on.')
      return
    }
    if (searchNode.status === 'dead') {
      setSearchMessage('This branch is dead. Select a live node to branch from.')
      return
    }
    if (searchTree.nodes.length + cellCandidates.length > MAX_NODES) {
      setSearchMessage(
        `Not enough room in the tree (${MAX_NODES} nodes max). Delete a branch first.`,
      )
      return
    }
    setSearchMessage(null)
    searchDispatch({ type: 'branch', cell })
    setAnnouncement(
      `Branched on ${cellName(cell)}: ${cellCandidates.length} options, ${cellCandidates.join(', ')}.`,
    )
  }, [searchTree, searchNode, state.selected, cellCandidates, searchDispatch])

  const searchErase = useCallback(() => {
    if (state.selected !== null) searchDispatch({ type: 'erase', cell: state.selected })
  }, [state.selected, searchDispatch])

  const applyBranch = useCallback(() => {
    if (!searchTree || !canApply(searchNode) || !searchNode) return
    const entries = pathEntries(searchTree, searchNode.id)
    dispatch({ type: 'applyPlacements', placements: entries })
    setSearchActive(false)
    setGuessPending(false)
    const text = `Applied ${entries.length} ${entries.length === 1 ? 'cell' : 'cells'} from ${nodeLabel(searchNode)} to the board. Undo reverts it in one step.`
    setNotice({ tone: 'success', text })
    setAnnouncement(text)
  }, [searchTree, searchNode])

  const resetTree = useCallback(() => {
    searchDispatch({ type: 'create', rootBoard: serializeGrid(state.cells) })
    allowSearchTree()
    setSearchMessage('New tree started from the current board.')
  }, [searchDispatch, state.cells, allowSearchTree])

  // Live sync with tree tabs (`/game/:id/tree`); this tab is the single writer.
  const syncSnapshot = useMemo<SnapshotInput>(
    () => ({
      tree: searchTree ? toWireTree(searchTree) : null,
      ui: {
        selectedStep: step,
        mode: searchTree?.mode ?? 'manual',
        searchActive: inSearch,
        editable: interactive,
        techniques: Object.fromEntries(search.techniques) as SnapshotUi['techniques'],
      },
      auto_placements: search.autoPlacements,
    }),
    [searchTree, step, inSearch, interactive, search.techniques, search.autoPlacements],
  )
  const onSyncCommand = (command: SyncCommand) => {
    if (!searchTree && command.type !== 'guess' && command.type !== 'branchAll') return
    switch (command.type) {
      case 'select':
        rawSearchDispatch({ type: 'select', nodeId: command.nodeId })
        setViewStep(command.step === null ? null : { nodeId: command.nodeId, step: command.step })
        return
      case 'toggleCollapse':
        searchDispatch({ type: 'collapse', nodeId: command.nodeId, collapsed: command.collapsed })
        return
    }
    // Editing commands: only while the game can be played. They turn search
    // mode on here if needed (the tree tab cannot do anything without it).
    if (!interactive) return
    if (!inSearch) enterSearch()
    switch (command.type) {
      case 'guess':
        rawSearchDispatch({ type: 'select', nodeId: command.nodeId })
        searchDispatch({ type: 'guess', cell: command.cell, value: command.value })
        setAnnouncement(
          `New branch from the tree tab: ${cellName(command.cell)} equals ${command.value}.`,
        )
        break
      case 'branchAll':
        rawSearchDispatch({ type: 'select', nodeId: command.nodeId })
        searchDispatch({ type: 'branch', cell: command.cell })
        setAnnouncement(`Branched on ${cellName(command.cell)} from the tree tab.`)
        break
      case 'deleteBranch':
        searchDispatch({ type: 'delete', nodeId: command.nodeId })
        break
    }
  }
  useSearchSyncHost(game.id, syncSnapshot, onSyncCommand)

  // Keyboard play.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isTypingTarget(event.target)) return
      if (document.querySelector('[aria-modal="true"]')) return
      const command = keyToCommand(event)
      if (!command || !interactive) return
      if (inSearch) {
        if (command.type === 'move') {
          const active = document.activeElement
          if (!(active === document.body || active?.closest('[role="grid"]'))) return
        }
        let handled = true
        switch (command.type) {
          case 'move':
            dispatch({ type: 'move', direction: command.direction })
            break
          case 'input':
            searchDigit(command.digit)
            break
          case 'erase':
            setGuessPending(false)
            searchErase()
            break
          case 'search':
            exitSearch()
            break
          case 'guess':
            setGuessPending(true)
            setSearchMessage(null)
            break
          case 'branch':
            setGuessPending(false)
            searchBranch()
            break
          case 'cancel':
            handled = guessPending
            setGuessPending(false)
            break
          default:
            handled = false
        }
        if (handled) event.preventDefault()
        return
      }
      if (command.type === 'guess' || command.type === 'branch' || command.type === 'cancel') return
      // Leave arrow keys alone unless the board (or nothing) has focus.
      if (command.type === 'move') {
        const active = document.activeElement
        const onBoard = active === document.body || active?.closest('[role="grid"]')
        if (!onBoard) return
      }
      event.preventDefault()
      switch (command.type) {
        case 'move':
          dispatch({ type: 'move', direction: command.direction })
          break
        case 'input':
          dispatch({ type: 'input', digit: command.digit })
          break
        case 'note':
          dispatch({ type: 'toggleNote', digit: command.digit })
          break
        case 'erase':
          dispatch({ type: 'erase' })
          break
        case 'toggleNotes':
          dispatch({ type: 'toggleNotesMode' })
          break
        case 'undo':
          dispatch({ type: 'undo' })
          break
        case 'redo':
          dispatch({ type: 'redo' })
          break
        case 'hint':
          onHintKey()
          break
        case 'search':
          enterSearch()
          break
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    interactive,
    onHintKey,
    inSearch,
    guessPending,
    searchDigit,
    searchErase,
    searchBranch,
    enterSearch,
    exitSearch,
  ])

  return (
    <div className="game">
      <div className="game__bar">
        <div className="game__title">
          <h1 className="game__heading">
            <GameBadges difficulty={game.difficulty} source={game.source} />
            <span className="visually-hidden"> Sudoku</span>
          </h1>
        </div>
        <dl className="game__stats">
          <div className="stat">
            <dt>Time</dt>
            <dd>
              <span aria-hidden="true">{formatDuration(timer.elapsed)}</span>
              <span className="visually-hidden">{describeDuration(timer.elapsed)}</span>
            </dd>
          </div>
          <div className="stat">
            <dt>Mistakes</dt>
            <dd>{mistakes}</dd>
          </div>
          <div className="stat">
            <dt>Hints</dt>
            <dd>{hintsUsed}</dd>
          </div>
          {search.autoPlacements > 0 && (
            <div className="stat">
              <dt>Auto</dt>
              <dd>
                {search.autoPlacements}
                <span className="visually-hidden"> auto-filled cells</span>
              </dd>
            </div>
          )}
        </dl>
        <div className="game__meta">
          {playing && (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <span
            className={`save-status save-status--${autosave.status}`}
            role="status"
            aria-live="polite"
          >
            {SAVE_TEXT[autosave.status]}
          </span>
        </div>
      </div>

      {notice && (
        <div className="game__notice">
          <Alert tone={notice.tone}>
            {notice.text}{' '}
            <button type="button" className="link-button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </Alert>
        </div>
      )}

      {!playing && result && (
        <div className="game__notice">
          <Alert tone="success" title="Solved">
            You scored {result.score} points in {formatDuration(result.elapsed)}.{' '}
            <button type="button" className="link-button" onClick={() => setShowResult(true)}>
              Show summary
            </button>
          </Alert>
        </div>
      )}

      <div className={`game__layout${inSearch ? ' game__layout--search' : ''}`}>
        <div className="game__board">
          {inSearch && searchNode && (
            <p className="search-banner">
              <span className="search-banner__tag">Search</span> Showing{' '}
              <strong>{nodeLabel(searchNode)}</strong>
              {step !== null &&
                (step < 0
                  ? ' (the guess only)'
                  : ` up to step ${step + 1} of ${searchNode.placements.length}`)}
              . The main board is read-only.
            </p>
          )}
          <Board
            state={displayState}
            onSelect={select}
            hidden={paused}
            label={
              inSearch && searchNode
                ? `Search board, ${nodeLabel(searchNode)}${step === null ? '' : `, step ${step + 2} of ${searchNode.placements.length + 1}`}`
                : undefined
            }
            search={searchMarks}
          />
          {paused && (
            <div className="board-overlay">
              <p>Paused</p>
              <button
                type="button"
                className="button button--primary"
                onClick={() => setPaused(false)}
              >
                Resume
              </button>
            </div>
          )}
        </div>

        <div className="game__side">
          {inSearch && searchNode ? (
            <>
              <SearchPanel
                tree={searchTree}
                node={searchNode}
                selectedCell={state.selected}
                cellCandidates={cellCandidates}
                guessPending={guessPending}
                autoPlacements={search.autoPlacements}
                costPerCell={game.search_costs.auto_placement}
                propagating={search.propagating}
                error={search.error}
                message={searchMessage}
                onGuess={() => {
                  setSearchMessage(null)
                  setGuessPending((g) => !g)
                }}
                onBranch={searchBranch}
                onErase={searchErase}
                onDelete={() => searchDispatch({ type: 'delete' })}
                onApply={applyBranch}
                onReset={resetTree}
                onExit={exitSearch}
                treeUrl={`/game/${game.id}/tree`}
                onSetMode={(mode) => searchDispatch({ type: 'setMode', mode })}
                selectedKey={selectedKey}
                techniques={search.techniques}
                viewStep={step}
                onSelectItem={(item) => {
                  rawSearchDispatch({ type: 'select', nodeId: item.nodeId })
                  setViewStep(item.chainEnd ? null : { nodeId: item.nodeId, step: item.step })
                }}
                onToggleCollapse={(nodeId) => searchDispatch({ type: 'collapse', nodeId })}
                onDismissError={search.clearError}
              />
              <NumberPad
                counts={counts}
                notesMode={false}
                verb={guessPending || searchNode.parent_id === null ? 'Guess' : 'Place'}
                disabled={!interactive}
                onDigit={searchDigit}
              />
            </>
          ) : (
            <>
              <Controls
                notesMode={state.notesMode}
                canUndo={canUndo(state)}
                canRedo={canRedo(state)}
                disabled={!interactive}
                checking={checking}
                hasSearchTree={searchTree !== null}
                onUndo={() => dispatch({ type: 'undo' })}
                onRedo={() => dispatch({ type: 'redo' })}
                onErase={() => dispatch({ type: 'erase' })}
                onToggleNotes={() => dispatch({ type: 'toggleNotesMode' })}
                onHint={() => setHintOpen(true)}
                onCheck={() => void check()}
                onSearch={enterSearch}
              />
              <NumberPad
                counts={counts}
                notesMode={state.notesMode}
                disabled={!interactive}
                onDigit={(digit) => dispatch({ type: 'input', digit })}
              />
              {hintOpen && interactive && (
                <HintPanel
                  hint={activeHint}
                  pending={hintPending}
                  error={hintError}
                  costOf={(stage) => hintCost(game, stage)}
                  onReveal={(stage) => void revealHint(stage)}
                  onApply={(index, value) => dispatch({ type: 'place', digit: value, index })}
                  onClose={closeHint}
                />
              )}
            </>
          )}
          <p className="game__keys">
            <kbd>←↑→↓</kbd> move · <kbd>1–9</kbd> enter · <kbd>Shift</kbd>+<kbd>1–9</kbd> note ·{' '}
            <kbd>N</kbd> notes mode · <kbd>⌫</kbd> erase · <kbd>H</kbd> hint · <kbd>Ctrl</kbd>+
            <kbd>Z</kbd> undo · <kbd>S</kbd> search
            {inSearch && (
              <>
                {' '}
                · <kbd>G</kbd> then <kbd>1–9</kbd> guess · <kbd>B</kbd> branch on all candidates ·{' '}
                <kbd>1–9</kbd> place in node
              </>
            )}
          </p>
        </div>
      </div>

      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>

      {showResult && result && (
        <CompletionDialog
          difficulty={game.difficulty}
          source={game.source}
          score={result.score}
          elapsedSeconds={result.elapsed}
          hintsUsed={hintsUsed}
          mistakes={mistakes}
          breakdown={result.breakdown}
          starting={startGame.isPending}
          onPlayAgain={(difficulty) => startGame.mutate(difficulty)}
          onClose={() => setShowResult(false)}
        />
      )}
    </div>
  )
}
