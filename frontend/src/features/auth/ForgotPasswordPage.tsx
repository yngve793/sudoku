import { useMutation } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { Link } from 'react-router'
import { authApi } from '../../api/endpoints'
import { Alert } from '../../components/Alert'
import { TextField } from '../../components/TextField'
import { errorMessage } from '../../lib/errors'
import { useCooldown } from '../../lib/useCooldown'
import { AuthCard } from './AuthCard'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const cooldown = useCooldown(60)
  const forgot = useMutation({
    mutationFn: authApi.forgotPassword,
    onSuccess: () => cooldown.start(),
  })

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim() || cooldown.active) return
    forgot.mutate(email.trim())
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter the email you signed up with and we'll send you a reset link."
      footer={<Link to="/login">Back to log in</Link>}
    >
      <form className="form" onSubmit={onSubmit}>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {forgot.isSuccess && (
          <Alert tone="success">
            If an account exists for that address, a reset link is on its way. It expires in 1 hour.
          </Alert>
        )}
        {forgot.isError && <Alert tone="error">{errorMessage(forgot.error)}</Alert>}
        <button
          type="submit"
          className="button button--primary button--block"
          disabled={forgot.isPending || cooldown.active}
        >
          {forgot.isPending
            ? 'Sending…'
            : cooldown.active
              ? `Send again in ${cooldown.remaining}s`
              : 'Send reset link'}
        </button>
      </form>
    </AuthCard>
  )
}
