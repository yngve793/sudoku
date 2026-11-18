import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { getAccessToken, getSession, setSession } from '../../api/client'
import { authApi } from '../../api/endpoints'
import { http, HttpResponse } from 'msw'
import { db } from '../../mocks/db'
import { server } from '../../mocks/node'
import { renderApp } from '../../test/utils'

describe('register -> check email -> verify -> login', () => {
  it('runs the full flow', async () => {
    const { user, router } = renderApp('/register')
    await user.type(await screen.findByLabelText('Username'), 'new_player')
    await user.type(screen.getByLabelText('Email'), 'New@Example.com')
    await user.type(screen.getByLabelText('Password'), 'supersecret')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(screen.getByText('New@Example.com')).toBeInTheDocument()
    // Just sent: the resend button starts in cooldown.
    expect(
      screen.getByRole('button', { name: /Resend verification email \(\d+s\)/ }),
    ).toBeDisabled()

    // Unverified login is refused with an inline resend prompt.
    await router.navigate('/login')
    await user.type(await screen.findByLabelText('Email or username'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'supersecret')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('Please verify your email')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resend verification email' }))
    expect(await screen.findByText(/a new link is on its way/)).toBeInTheDocument()
    expect(db.outbox.filter((m) => m.to === 'new@example.com')).toHaveLength(2)

    // Follow the most recent link.
    const token = db.outbox.at(-1)!.token
    await router.navigate(`/verify-email?token=${token}`)
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument()
    // The single-use token is removed from the address bar.
    expect(router.state.location.search).toBe('')

    await user.click(within(screen.getByRole('main')).getByRole('link', { name: 'Log in' }))
    await user.type(await screen.findByLabelText('Email or username'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'supersecret')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('heading', { name: 'Hi, new_player' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
  })

  it('validates the form client-side', async () => {
    const { user } = renderApp('/register')
    await user.type(await screen.findByLabelText('Username'), 'ab')
    await user.type(screen.getByLabelText('Email'), 'nope')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(screen.getByText('Use 3–20 letters, digits or underscores.')).toBeInTheDocument()
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true')
  })

  it('maps a server validation_error onto the right fields', async () => {
    server.use(
      http.post('*/api/v1/auth/register', () =>
        HttpResponse.json(
          {
            detail:
              "username: String should match pattern '^[A-Za-z0-9_]{3,20}$'; email: value is not a valid email address",
            code: 'validation_error',
          },
          { status: 422 },
        ),
      ),
    )
    const { user } = renderApp('/register')
    await user.type(await screen.findByLabelText('Username'), 'valid_name')
    await user.type(screen.getByLabelText('Email'), 'a@b.co')
    await user.type(screen.getByLabelText('Password'), 'supersecret')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Use 3–20 letters, digits or underscores.')).toBeInTheDocument()
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
  })

  it('gives the same answer for an already-registered email (no enumeration)', async () => {
    const { user } = renderApp('/register')
    await user.type(await screen.findByLabelText('Username'), 'someone_new')
    await user.type(screen.getByLabelText('Email'), 'demo@example.com')
    await user.type(screen.getByLabelText('Password'), 'supersecret')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(db.outbox).toHaveLength(0)
  })

  it('shows username_taken from the server on the field', async () => {
    const { user } = renderApp('/register')
    await user.type(await screen.findByLabelText('Username'), 'demo')
    await user.type(screen.getByLabelText('Email'), 'other@example.com')
    await user.type(screen.getByLabelText('Password'), 'supersecret')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('This username is already taken')).toBeInTheDocument()
  })
})

describe('verify email', () => {
  it('fails for an invalid or reused token and offers a resend', async () => {
    renderApp('/verify-email?token=bogus')
    expect(await screen.findByRole('heading', { name: 'Verification failed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resend verification email' })).toBeInTheDocument()
  })

  it('handles a missing token', async () => {
    renderApp('/verify-email')
    expect(
      await screen.findByRole('heading', { name: 'Verification link missing' }),
    ).toBeInTheDocument()
  })
})

describe('login', () => {
  it('accepts a username instead of an email', async () => {
    const { user } = renderApp('/login')
    await user.type(await screen.findByLabelText('Email or username'), 'demo')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('heading', { name: 'Hi, demo' })).toBeInTheDocument()
    // The user comes from the login response.
    expect(getSession()?.user.username).toBe('demo')
  })

  it('asks for the email to resend verification when logging in by username', async () => {
    db.users.push({
      id: 999,
      username: 'pending',
      email: 'pending@example.com',
      password: 'password123',
      verified: false,
      created_at: new Date().toISOString(),
      last_login_at: null,
    })
    const { user } = renderApp('/login')
    await user.type(await screen.findByLabelText('Email or username'), 'pending')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('Please verify your email')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Email'), 'pending@example.com')
    await user.click(screen.getByRole('button', { name: 'Resend verification email' }))
    expect(await screen.findByText(/a new link is on its way/)).toBeInTheDocument()
    expect(db.outbox.at(-1)?.to).toBe('pending@example.com')
  })

  it('shows an error for wrong credentials', async () => {
    const { user } = renderApp('/login')
    await user.type(await screen.findByLabelText('Email or username'), 'demo@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.')
  })

  it('redirects protected routes to login and back after logging in', async () => {
    const { user, router } = renderApp('/game/123')
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Email or username'), 'demo@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/game/123'))
    expect(await screen.findByText('Game not found')).toBeInTheDocument()
  })

  it('logs out', async () => {
    const { user } = renderApp('/login')
    await user.type(await screen.findByLabelText('Email or username'), 'demo@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    await user.click(await screen.findByRole('button', { name: 'Log out' }))
    expect(
      await screen.findByRole('heading', { name: /Sudoku that teaches you to think/ }),
    ).toBeInTheDocument()
  })
})

describe('password reset', () => {
  it('requests a link without revealing whether the account exists, then resets', async () => {
    const first = renderApp('/forgot-password')
    await first.user.type(await screen.findByLabelText('Email'), 'nobody@example.com')
    await first.user.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText(/If an account exists/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Send again in/ })).toBeDisabled()
    expect(db.outbox).toHaveLength(0)
    first.unmount()

    const { user, router } = renderApp('/forgot-password')
    await user.type(await screen.findByLabelText('Email'), 'demo@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText(/If an account exists/)).toBeInTheDocument()
    expect(db.outbox).toHaveLength(1)

    await router.navigate(`/reset-password?token=${db.outbox[0]!.token}`)
    await user.type(await screen.findByLabelText('New password'), 'brand-new-pass')
    await user.type(screen.getByLabelText('Confirm new password'), 'brand-new-pass')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByRole('heading', { name: 'Password updated' })).toBeInTheDocument()
    expect(db.users.find((u) => u.email === 'demo@example.com')?.password).toBe('brand-new-pass')
  })

  it('rejects mismatched passwords and invalid tokens', async () => {
    const { user } = renderApp('/reset-password?token=bad')
    await user.type(await screen.findByLabelText('New password'), 'brand-new-pass')
    await user.type(screen.getByLabelText('Confirm new password'), 'different-pass')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Confirm new password'))
    await user.type(screen.getByLabelText('Confirm new password'), 'brand-new-pass')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument()
  })
})

describe('session restore', () => {
  it('restores the session from the refresh cookie without a stored access token', async () => {
    await authApi.login({ email: 'demo@example.com', password: 'password123' })
    setSession(null) // simulate a page reload: memory is empty, cookie remains
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Hi, demo' })).toBeInTheDocument()
    expect(getAccessToken()).not.toBeNull()
  })

  it('stays logged out when there is no refresh cookie', async () => {
    renderApp('/')
    expect(
      await screen.findByRole('heading', { name: /Sudoku that teaches you to think/ }),
    ).toBeInTheDocument()
    expect(getAccessToken()).toBeNull()
  })
})
