import type { ReactNode } from 'react'

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <h1 id="auth-title" className="auth-card__title">
        {title}
      </h1>
      {subtitle && <p className="auth-card__subtitle">{subtitle}</p>}
      {children}
      {footer && <div className="auth-card__footer">{footer}</div>}
    </section>
  )
}
