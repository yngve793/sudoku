import { Link, useLocation } from 'react-router'
import { AuthCard } from './AuthCard'
import { ResendVerification } from './ResendVerification'

export function CheckEmailPage() {
  const location = useLocation()
  const email = (location.state as { email?: string } | null)?.email
  return (
    <AuthCard
      title="Check your email"
      subtitle={
        email ? (
          <>
            We sent a verification link to <strong>{email}</strong>. It expires in 24 hours.
          </>
        ) : (
          'We sent you a verification link. It expires in 24 hours.'
        )
      }
      footer={
        <span>
          Verified already? <Link to="/login">Log in</Link>
        </span>
      }
    >
      <div className="check-email__art" aria-hidden="true">
        ✉
      </div>
      <p>Didn&apos;t get it? Check your spam folder, or send a new link.</p>
      <ResendVerification email={email} startCoolingDown={Boolean(email)} />
    </AuthCard>
  )
}
