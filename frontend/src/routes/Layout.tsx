import { NavLink, Outlet, useNavigate } from 'react-router'
import { useTheme } from '../app/themeContext'
import { useAuth } from '../features/auth/authContext'

const THEME_LABEL = { system: 'Auto', light: 'Light', dark: 'Dark' } as const
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' } as const

export function Layout() {
  const { status, user, logout } = useAuth()
  const { theme, cycleTheme } = useTheme()
  const navigate = useNavigate()

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Sudoku home">
          <span className="brand__mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span className="brand__name">Sudoku</span>
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end className="nav__link">
            Play
          </NavLink>
          <NavLink to="/leaderboard" className="nav__link">
            Leaderboard
          </NavLink>
        </nav>
        <div className="topbar__actions">
          <button
            type="button"
            className="icon-button"
            onClick={cycleTheme}
            aria-label={`Colour theme: ${THEME_LABEL[theme]}. Change theme`}
            title={`Theme: ${THEME_LABEL[theme]}`}
          >
            <span aria-hidden="true">{THEME_ICON[theme]}</span>
          </button>
          {status === 'authenticated' && user ? (
            <>
              <span className="topbar__user">{user.username}</span>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() =>
                  void logout().finally(() => {
                    void navigate('/')
                  })
                }
              >
                Log out
              </button>
            </>
          ) : status === 'anonymous' ? (
            <>
              <NavLink to="/login" className="button button--ghost button--small">
                Log in
              </NavLink>
              <NavLink to="/register" className="button button--primary button--small hide-xs">
                Sign up
              </NavLink>
            </>
          ) : null}
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
