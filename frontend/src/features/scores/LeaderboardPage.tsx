import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { scoresApi } from '../../api/endpoints'
import { DIFFICULTIES, type Difficulty, type LeaderboardPeriod } from '../../api/types'
import { Alert } from '../../components/Alert'
import { Spinner } from '../../components/Spinner'
import { DIFFICULTY_INFO } from '../../lib/difficulties'
import { errorMessage } from '../../lib/errors'
import { formatDate, formatDuration, formatNumber } from '../../lib/format'
import { useAuth } from '../auth/authContext'

const PERIODS: { value: LeaderboardPeriod; label: string }[] = [
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'all', label: 'All time' },
]

type DifficultyFilter = Difficulty | 'all'

function parseDifficulty(value: string | null): DifficultyFilter {
  return DIFFICULTIES.find((d) => d === value) ?? 'all'
}

const filterLabel = (d: DifficultyFilter) => (d === 'all' ? 'All levels' : DIFFICULTY_INFO[d].label)

function parsePeriod(value: string | null): LeaderboardPeriod {
  return PERIODS.find((p) => p.value === value)?.value ?? 'week'
}

export function LeaderboardPage() {
  const { user, status } = useAuth()
  const [params, setParams] = useSearchParams()
  const difficulty = parseDifficulty(params.get('difficulty'))
  const period = parsePeriod(params.get('period'))

  const apiDifficulty = difficulty === 'all' ? null : difficulty
  const board = useQuery({
    queryKey: ['leaderboard', difficulty, period],
    queryFn: () => scoresApi.leaderboard(apiDifficulty, period),
  })
  const mine = useQuery({
    queryKey: ['leaderboard', 'me', difficulty, period],
    queryFn: () => scoresApi.leaderboardMe(apiDifficulty, period),
    enabled: status === 'authenticated',
  })
  const showLevel = difficulty === 'all'

  function update(next: { difficulty?: DifficultyFilter; period?: LeaderboardPeriod }) {
    setParams(
      { difficulty: next.difficulty ?? difficulty, period: next.period ?? period },
      { replace: true },
    )
  }

  const entries = board.data?.entries ?? []
  const myRank = mine.data?.rank ?? null
  const myEntry = mine.data?.entry ?? null
  const inList = myRank !== null && entries.some((e) => e.rank === myRank)

  return (
    <div className="page leaderboard">
      <header className="page__header">
        <h1 className="page__title">Leaderboard</h1>
        <p className="page__lead">
          Top scores from verified players. Scores are verified by the server.
        </p>
        <p className="page__note">
          Games imported from a photo aren&apos;t ranked here; they still count in your own stats.
        </p>
      </header>

      <div className="filters">
        <div className="field field--inline">
          <label htmlFor="lb-difficulty" className="field__label">
            Difficulty
          </label>
          <select
            id="lb-difficulty"
            className="field__input"
            value={difficulty}
            onChange={(e) => update({ difficulty: parseDifficulty(e.target.value) })}
          >
            <option value="all">All levels</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {DIFFICULTY_INFO[d].label}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="segmented">
          <legend className="visually-hidden">Period</legend>
          {PERIODS.map((p) => (
            <label key={p.value} className="segmented__option">
              <input
                type="radio"
                name="period"
                value={p.value}
                checked={period === p.value}
                onChange={() => update({ period: p.value })}
              />
              <span>{p.label}</span>
            </label>
          ))}
        </fieldset>
      </div>

      {status === 'authenticated' && mine.data && (
        <p className="my-rank" role="status">
          {myRank !== null && myEntry
            ? `Your rank: #${myRank} of ${formatNumber(mine.data.total)}, with ${formatNumber(myEntry.score)} points`
            : difficulty === 'all'
              ? "You don't have a ranked score for this period yet."
              : `You don't have a ranked ${DIFFICULTY_INFO[difficulty].label} score for this period yet.`}
        </p>
      )}

      {board.isPending ? (
        <Spinner label="Loading leaderboard" />
      ) : board.isError ? (
        <Alert tone="error">{errorMessage(board.error)}</Alert>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <p>
            No scores yet{difficulty === 'all' ? '' : ` for ${DIFFICULTY_INFO[difficulty].label}`}{' '}
            in this period.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">
              {filterLabel(difficulty)} leaderboard,{' '}
              {PERIODS.find((p) => p.value === period)?.label}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  Rank
                </th>
                <th scope="col">Player</th>
                {showLevel && <th scope="col">Level</th>}
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col" className="num">
                  Time
                </th>
                <th scope="col" className="num">
                  Hints
                </th>
                <th scope="col" className="hide-sm">
                  Date
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const isMe = user !== null && myRank === e.rank && e.username === user.username
                return (
                  <tr
                    key={`${e.rank}-${e.username}`}
                    className={isMe ? 'row--me' : undefined}
                    aria-current={isMe ? 'true' : undefined}
                  >
                    <td className="num">
                      <span className={`rank${e.rank <= 3 ? ` rank--${e.rank}` : ''}`}>
                        {e.rank}
                      </span>
                    </td>
                    <th scope="row" className="player">
                      {e.username}
                      {isMe && <span className="badge badge--accent">You</span>}
                    </th>
                    {showLevel && <td>{DIFFICULTY_INFO[e.difficulty].label}</td>}
                    <td className="num">{formatNumber(e.score)}</td>
                    <td className="num">{formatDuration(e.elapsed_seconds)}</td>
                    <td className="num">{e.hints_used}</td>
                    <td className="hide-sm">{formatDate(e.completed_at)}</td>
                  </tr>
                )
              })}
              {myEntry && myRank !== null && !inList && (
                <tr className="row--me row--detached" aria-current="true">
                  <td className="num">
                    <span className="rank">{myRank}</span>
                  </td>
                  <th scope="row" className="player">
                    {myEntry.username}
                    <span className="badge badge--accent">You</span>
                  </th>
                  {showLevel && <td>{DIFFICULTY_INFO[myEntry.difficulty].label}</td>}
                  <td className="num">{formatNumber(myEntry.score)}</td>
                  <td className="num">{formatDuration(myEntry.elapsed_seconds)}</td>
                  <td className="num">{myEntry.hints_used}</td>
                  <td className="hide-sm">{formatDate(myEntry.completed_at)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
