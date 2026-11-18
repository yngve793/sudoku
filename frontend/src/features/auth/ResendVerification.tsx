import { useMutation } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { authApi } from '../../api/endpoints'
import { Alert } from '../../components/Alert'
import { TextField } from '../../components/TextField'
import { errorMessage } from '../../lib/errors'
import { useCooldown } from '../../lib/useCooldown'

export const RESEND_COOLDOWN_SECONDS = 60

interface ResendVerificationProps {
  /** Known address; when omitted, an email field is shown. */
  email?: string | undefined
  /** Start in cooldown (an email was just sent). */
  startCoolingDown?: boolean
  label?: string
}

export function ResendVerification({
  email: knownEmail,
  startCoolingDown = false,
  label = 'Resend verification email',
}: ResendVerificationProps) {
  const [email, setEmail] = useState(knownEmail ?? '')
  const cooldown = useCooldown(RESEND_COOLDOWN_SECONDS, startCoolingDown)

  const resend = useMutation({
    mutationFn: (address: string) => authApi.resendVerification(address),
    onSuccess: () => cooldown.start(),
  })

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email || cooldown.active) return
    resend.mutate(email)
  }

  return (
    <form className="resend" onSubmit={onSubmit} noValidate>
      {!knownEmail && (
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      )}
      <button
        type="submit"
        className="button button--secondary"
        disabled={resend.isPending || cooldown.active || !email}
      >
        {resend.isPending
          ? 'Sending…'
          : cooldown.active
            ? `${label} (${cooldown.remaining}s)`
            : label}
      </button>
      {resend.isSuccess && (
        <Alert tone="success">If that address needs verifying, a new link is on its way.</Alert>
      )}
      {resend.isError && <Alert tone="error">{errorMessage(resend.error)}</Alert>}
    </form>
  )
}
