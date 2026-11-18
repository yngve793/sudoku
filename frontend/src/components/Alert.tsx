import type { ReactNode } from 'react'

interface AlertProps {
  tone?: 'info' | 'success' | 'error' | 'warning'
  title?: string
  children: ReactNode
}

const ICONS = { info: 'i', success: '✓', error: '!', warning: '!' } as const

/** Status message. Errors use role="alert", others a polite live region. */
export function Alert({ tone = 'info', title, children }: AlertProps) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="alert__icon" aria-hidden="true">
        {ICONS[tone]}
      </span>
      <div className="alert__body">
        {title && <p className="alert__title">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  )
}
