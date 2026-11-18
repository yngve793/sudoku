import { useState, type SubmitEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { isApiError } from '../../api/client'
import { Alert } from '../../components/Alert'
import { TextField } from '../../components/TextField'
import { errorMessage } from '../../lib/errors'
import { AuthCard } from './AuthCard'
import { useAuth } from './authContext'
import { ResendVerification } from './ResendVerification'

interface LocationState {
  from?: string
}

export function LoginPage() {
  const { login, status } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as LocationState | null)?.from ?? '/'
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)

  if (status === 'authenticated' && !pending) return <Navigate to={from} replace />

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await login(identifier.trim(), password)
      void navigate(from, { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setPending(false)
    }
  }

  const notVerified = isApiError(error, 'email_not_verified')
  // Resend needs an email address; if they logged in with a username, ask for it.
  const knownEmail = identifier.includes('@') ? identifier.trim() : undefined

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Log in to resume your game and climb the leaderboard."
      footer={
        <>
          <Link to="/forgot-password">Forgot your password?</Link>
          <span>
            New here? <Link to="/register">Create an account</Link>
          </span>
        </>
      }
    >
      <form className="form" onSubmit={(e) => void onSubmit(e)}>
        <TextField
          label="Email or username"
          name="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error !== null && !notVerified && (
          <Alert tone="error">
            {isApiError(error, 'invalid_credentials')
              ? 'Incorrect email or password.'
              : errorMessage(error)}
          </Alert>
        )}
        <button type="submit" className="button button--primary button--block" disabled={pending}>
          {pending ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      {notVerified && (
        <div className="inline-prompt">
          <Alert tone="warning" title="Please verify your email">
            We sent you a verification link when you signed up. Click it, then log in again.
          </Alert>
          <ResendVerification email={knownEmail} />
        </div>
      )}
    </AuthCard>
  )
}
