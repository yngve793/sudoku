import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { isApiError } from '../../api/client'
import { gamesApi } from '../../api/endpoints'
import type { Game, Hint, HintStage, ScoreBreakdown } from '../../api/types'
import { Alert } from '../../components/Alert'
import { DIFFICULTY_INFO } from '../../lib/difficulties'
import { errorMessage } from '../../lib/errors'
import { describeDuration, formatDuration } from '../../lib/format'
import { Board } from './Board'
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
import { cellName, digitCounts } from './grid'
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
  const autosave = useAutosave({
    gameId: game.id,
    initialVersion: game.version,
    initialElapsed: game.elapsed_seconds,
    state,
    dispatch,
    elapsedRef: timer.elapsedRef,
    enabled: playing,
    onConflict,
  })
  const { flush } = autosave

  const counts = useMemo(() => digitCounts(state.cells), [state.cells])
  const interactive = playing && !paused

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

  // Keyboard play.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isTypingTarget(event.target)) return
      if (document.querySelector('[aria-modal="true"]')) return
      const command = keyToCommand(event)
      if (!command || !interactive) return
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
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [interactive, onHintKey])

  const info = DIFFICULTY_INFO[game.difficulty]

  return (
    <div className="game">
      <div className="game__bar">
        <div className="game__title">
          <h1 className="game__heading">
            <span className={`badge badge--level badge--${game.difficulty}`}>{info.label}</span>
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

      <div className="game__layout">
        <div className="game__board">
          <Board state={state} onSelect={select} hidden={paused} />
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
          <Controls
            notesMode={state.notesMode}
            canUndo={canUndo(state)}
            canRedo={canRedo(state)}
            disabled={!interactive}
            checking={checking}
            onUndo={() => dispatch({ type: 'undo' })}
            onRedo={() => dispatch({ type: 'redo' })}
            onErase={() => dispatch({ type: 'erase' })}
            onToggleNotes={() => dispatch({ type: 'toggleNotesMode' })}
            onHint={() => setHintOpen(true)}
            onCheck={() => void check()}
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
          <p className="game__keys">
            <kbd>←↑→↓</kbd> move · <kbd>1–9</kbd> enter · <kbd>Shift</kbd>+<kbd>1–9</kbd> note ·{' '}
            <kbd>N</kbd> notes mode · <kbd>⌫</kbd> erase · <kbd>H</kbd> hint · <kbd>Ctrl</kbd>+
            <kbd>Z</kbd> undo
          </p>
        </div>
      </div>

      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>

      {showResult && result && (
        <CompletionDialog
          difficulty={game.difficulty}
          score={result.score}
          elapsedSeconds={result.elapsed}
          hintsUsed={hintsUsed}
          mistakes={mistakes}
          breakdown={result.breakdown}
          starting={startGame.isPending}
          onPlayAgain={() => startGame.mutate(game.difficulty)}
          onClose={() => setShowResult(false)}
        />
      )}
    </div>
  )
}
