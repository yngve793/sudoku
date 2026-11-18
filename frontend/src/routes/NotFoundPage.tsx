import { Link } from 'react-router'

export function NotFoundPage() {
  return (
    <div className="page page--narrow empty-state">
      <h1 className="page__title">Page not found</h1>
      <p>That page doesn&apos;t exist.</p>
      <Link className="button button--primary" to="/">
        Go home
      </Link>
    </div>
  )
}
