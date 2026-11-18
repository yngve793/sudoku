import { useMutation } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { authApi } from '../../api/endpoints'
import { Alert } from '../../components/Alert'
import { TextField } from '../../components/TextField'
import { errorMessage, fieldErrors } from '../../lib/errors'
import { AuthCard } from './AuthCard'
import { EMAIL_RE, MIN_PASSWORD, USERNAME_RE } from './validation'

export function RegisterPage() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [local, setLocal] = useState<Record<string, string>>({})

  const register = useMutation({
    mutationFn: authApi.register,
    onSuccess: () => void navigate('/check-email', { state: { email: email.trim() } }),
  })

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors: Record<string, string> = {}
    if (!USERNAME_RE.test(username.trim()))
      errors.username = 'Use 3–20 letters, digits or underscores.'
    if (!EMAIL_RE.test(email.trim())) errors.email = 'Enter a valid email address.'
    if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`
    setLocal(errors)
    if (Object.keys(errors).length) return
    register.mutate({ username: username.trim(), email: email.trim(), password })
  }

  // Field errors from the server (validation_error, username_* codes).
  const server = fieldErrors(register.error)
  const showGeneric = register.isError && Object.keys(server).length === 0

  return (
    <AuthCard
      title="Create your account"
      subtitle="Your username is shown on the public leaderboard. Your email never is."
      footer={
        <span>
          Already have an account? <Link to="/login">Log in</Link>
        </span>
      }
    >
      <form className="form" onSubmit={onSubmit} noValidate>
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          hint="3–20 characters: letters, digits and underscores."
          required
          value={username}
          error={local.username ?? server.username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          error={local.email ?? server.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          required
          value={password}
          error={local.password ?? server.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {showGeneric && <Alert tone="error">{errorMessage(register.error)}</Alert>}
        <button
          type="submit"
          className="button button--primary button--block"
          disabled={register.isPending}
        >
          {register.isPending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthCard>
  )
}
