import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { authApi, gamesApi, scoresApi } from '../../api/endpoints'
import { DIFFICULTIES, type Difficulty, type Game, type ScoresMe } from '../../api/types'
import { Alert } from '../../components/Alert'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { GameBadges } from '../../components/GameBadges'
import { DIFFICULTY_INFO, difficultyLabel } from '../../lib/difficulties'
import { errorMessage } from '../../lib/errors'
import { formatDate, formatDuration, formatNumber } from '../../lib/format'
import { meQueryKey, useAuth } from '../auth/authContext'
import { currentGameQueryKey, useStartGame } from '../game/useStartGame'
import { DifficultyPicker } from './DifficultyPicker'

function progress(game: Game): number {
  const givens = [...game.givens].filter((c) => c !== '0').length
  const filled = [...game.current].filter((c) => c !== '0').length
  const open = 81 - givens
  return open === 0 ? 100 : Math.round(((filled - givens) / open) * 100)
}

function ResumeCard({ game }: { game: Game }) {
  const pct = progress(game)
  return (
    <section className="card resume-card" aria-labelledby="resume-title">
      <div>
        <h2 id="resume-title" className="card__title">
          Continue your game
        </h2>
        <p className="resume-card__meta">
          <GameBadges difficulty={game.difficulty} source={game.source} />
          <span>{formatDuration(game.elapsed_seconds)} played</span>
          <span>{pct}% filled</span>
        </p>
        <div
          className="progress"
          role="progressbar"
          aria-label="Board filled"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="progress__bar" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <Link className="button button--primary" to={`/game/${game.id}`}>
        Resume
      </Link>
    </section>
  )
}

function Stats() {
  const me = useQuery({ queryKey: meQueryKey, queryFn: authApi.me })
  const scores = useQuery({ queryKey: ['scores', 'me'], queryFn: scoresApi.mine })
  const best = new Map((scores.data?.best ?? []).map((entry) => [entry.difficulty, entry]))
  const stats = me.data?.stats
  return (
    <section className="card" aria-labelledby="stats-title">
      <h2 id="stats-title" className="card__title">
        Your stats
      </h2>
      <dl className="stats-grid">
        <div>
          <dt>Games started</dt>
          <dd>{stats ? stats.games_started : '—'}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{stats ? stats.games_completed : '—'}</dd>
        </div>
        <div>
          <dt>Total score</dt>
          <dd>{stats ? formatNumber(stats.total_score) : '—'}</dd>
        </div>
      </dl>
      <h3 className="card__subtitle">Best scores</h3>
      {scores.isPending ? (
        <Spinner label="Loading scores" />
      ) : scores.isError ? (
        <Alert tone="error">{errorMessage(scores.error)}</Alert>
      ) : (
        <table className="table table--compact">
          <thead>
            <tr>
              <th scope="col">Difficulty</th>
              <th scope="col" className="num">
                Score
              </th>
              <th scope="col" className="num">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {DIFFICULTIES.map((d) => {
              const entry = best.get(d)
              return (
                <tr key={d}>
                  <th scope="row">{DIFFICULTY_INFO[d].label}</th>
                  <td className="num">{entry ? formatNumber(entry.score) : '—'}</td>
                  <td className="num">{entry ? formatDuration(entry.elapsed_seconds) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <RecentGames history={scores.data?.history ?? []} />
    </section>
  )
}

const STATUS_LABEL = { in_progress: 'In progress', completed: 'Completed', abandoned: 'Abandoned' }

function RecentGames({ history }: { history: ScoresMe['history'] }) {
  if (!history.length) return null
  return (
    <>
      <h3 className="card__subtitle">Recent games</h3>
      <ul className="history-list">
        {history.slice(0, 5).map((item) => (
          <li key={item.game_id} className="history-list__item">
            <span className="history-list__badges">
              <GameBadges difficulty={item.difficulty} source={item.source} />
            </span>
            <span className="history-list__meta">
              {STATUS_LABEL[item.status]}
              {item.score !== null && ` · ${formatNumber(item.score)} pts`} ·{' '}
              {formatDate(item.started_at)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

function ImportCard() {
  return (
    <div className="import-entry">
      <div>
        <h3 className="import-entry__title">Got a puzzle on paper?</h3>
        <p className="import-entry__text">
          Snap or upload a photo of a printed Sudoku, even a half-solved one. You review what we
          read before you play.
        </p>
      </div>
      <Link className="button button--secondary" to="/import">
        Import from photo
      </Link>
    </div>
  )
}

function Dashboard() {
  const { user } = useAuth()
  const current = useQuery({ queryKey: currentGameQueryKey, queryFn: gamesApi.current })
  const startGame = useStartGame()
  const [confirm, setConfirm] = useState<Difficulty | null>(null)

  function pick(difficulty: Difficulty) {
    if (current.data) setConfirm(difficulty)
    else startGame.mutate(difficulty)
  }

  return (
    <div className="page home">
      <header className="page__header">
        <h1 className="page__title">Hi, {user?.username}</h1>
        <p className="page__lead">Pick up where you left off, or start a fresh puzzle.</p>
      </header>
      <div className="home__grid">
        <div className="home__main">
          {current.data && <ResumeCard game={current.data} />}
          <section aria-labelledby="new-game-title">
            <h2 id="new-game-title" className="section-title">
              New game
            </h2>
            {startGame.isError && <Alert tone="error">{errorMessage(startGame.error)}</Alert>}
            <DifficultyPicker
              onPick={pick}
              pending={startGame.isPending ? startGame.variables : null}
              disabled={startGame.isPending}
            />
            <ImportCard />
          </section>
        </div>
        <aside className="home__side">
          <Stats />
        </aside>
      </div>
      {confirm && (
        <Modal title="Start a new game?" onClose={() => setConfirm(null)}>
          <p>
            Starting a {DIFFICULTY_INFO[confirm].label} game will abandon your current{' '}
            {current.data && difficultyLabel(current.data.difficulty)} game.
          </p>
          <div className="modal__actions">
            <button type="button" className="button button--ghost" onClick={() => setConfirm(null)}>
              Keep playing
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={startGame.isPending}
              onClick={() => {
                startGame.mutate(confirm)
                setConfirm(null)
              }}
            >
              Start new game
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Landing() {
  return (
    <div className="page landing">
      <section className="hero">
        <h1 className="hero__title">Sudoku that teaches you to think.</h1>
        <p className="hero__lead">
          Seven difficulty levels, each proven to have exactly one solution and solvable without
          guessing. Stuck? Hints explain the next logical step, one stage at a time.
        </p>
        <div className="hero__actions">
          <Link className="button button--primary button--large" to="/register">
            Create a free account
          </Link>
          <Link className="button button--secondary button--large" to="/login">
            Log in
          </Link>
        </div>
        <p>
          Or just <Link to="/leaderboard">browse the leaderboard</Link>.
        </p>
      </section>
      <section aria-labelledby="levels-title">
        <h2 id="levels-title" className="section-title">
          Seven levels, one technique at a time
        </h2>
        <ul className="level-list">
          {DIFFICULTIES.map((d) => (
            <li key={d} className="level-list__item">
              <span className={`badge badge--level badge--${d}`}>{DIFFICULTY_INFO[d].label}</span>
              <span>{DIFFICULTY_INFO[d].techniques}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export function HomePage() {
  const { status } = useAuth()
  if (status === 'loading') return <Spinner />
  return status === 'authenticated' ? <Dashboard /> : <Landing />
}
