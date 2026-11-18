import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { authApi } from '../../api/endpoints'
import { Alert } from '../../components/Alert'
import { Spinner } from '../../components/Spinner'
import { AuthCard } from './AuthCard'
import { ResendVerification } from './ResendVerification'

export function VerifyEmailPage() {
  const [params, setParams] = useSearchParams()
  // Read the single-use token once, then drop it from the address bar.
  const [token] = useState(() => params.get('token'))
  const started = useRef(false)

  const verify = useMutation({ mutationFn: authApi.verifyEmail })

  useEffect(() => {
    if (started.current || !token) return
    started.current = true
    verify.mutate(token)
    setParams({}, { replace: true })
  }, [token, verify, setParams])

  if (!token) {
    return (
      <AuthCard title="Verification link missing" subtitle="This link has no token in it.">
        <p>Request a new verification email:</p>
        <ResendVerification />
      </AuthCard>
    )
  }

  if (verify.isSuccess) {
    return (
      <AuthCard title="Email verified">
        <Alert tone="success">Your email address is confirmed. You can log in now.</Alert>
        <Link className="button button--primary button--block" to="/login">
          Log in
        </Link>
      </AuthCard>
    )
  }

  if (verify.isError) {
    return (
      <AuthCard title="Verification failed">
        <Alert tone="error">
          This verification link is invalid, has expired, or was already used.
        </Alert>
        <p>Enter your email to get a new link:</p>
        <ResendVerification />
        <p>
          Already verified? <Link to="/login">Log in</Link>
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Verifying your email…">
      <Spinner label="Verifying your email" />
    </AuthCard>
  )
}
