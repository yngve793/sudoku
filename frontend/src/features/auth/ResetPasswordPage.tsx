import { useMutation } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { isApiError } from '../../api/client'
import { authApi } from '../../api/endpoints'
import { Alert } from '../../components/Alert'
import { TextField } from '../../components/TextField'
import { errorMessage, fieldErrors } from '../../lib/errors'
import { AuthCard } from './AuthCard'
import { MIN_PASSWORD } from './validation'

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [local, setLocal] = useState<Record<string, string>>({})
  const reset = useMutation({ mutationFn: authApi.resetPassword })

  if (!token) {
    return (
      <AuthCard title="Reset link missing">
        <Alert tone="error">This reset link is incomplete.</Alert>
        <Link to="/forgot-password">Request a new reset link</Link>
      </AuthCard>
    )
  }

  if (reset.isSuccess) {
    return (
      <AuthCard title="Password updated">
        <Alert tone="success">
          Your password has been changed and all other sessions were signed out.
        </Alert>
        <Link className="button button--primary button--block" to="/login">
          Log in
        </Link>
      </AuthCard>
    )
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors: Record<string, string> = {}
    if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`
    if (confirm !== password) errors.confirm = 'Passwords do not match.'
    setLocal(errors)
    if (Object.keys(errors).length || !token) return
    reset.mutate({ token, new_password: password })
  }

  const server = fieldErrors(reset.error)
  const invalidToken = isApiError(reset.error, 'invalid_token')

  return (
    <AuthCard title="Choose a new password">
      <form className="form" onSubmit={onSubmit} noValidate>
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          required
          value={password}
          error={local.password ?? server.new_password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          error={local.confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {invalidToken && (
          <Alert tone="error">
            This reset link is invalid or has expired.{' '}
            <Link to="/forgot-password">Request a new one</Link>.
          </Alert>
        )}
        {reset.isError && !invalidToken && Object.keys(server).length === 0 && (
          <Alert tone="error">{errorMessage(reset.error)}</Alert>
        )}
        <button
          type="submit"
          className="button button--primary button--block"
          disabled={reset.isPending}
        >
          {reset.isPending ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </AuthCard>
  )
}
