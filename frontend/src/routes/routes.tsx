import type { RouteObject } from 'react-router'
import { CheckEmailPage } from '../features/auth/CheckEmailPage'
import { ForgotPasswordPage } from '../features/auth/ForgotPasswordPage'
import { LoginPage } from '../features/auth/LoginPage'
import { RegisterPage } from '../features/auth/RegisterPage'
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage'
import { VerifyEmailPage } from '../features/auth/VerifyEmailPage'
import { GamePage } from '../features/game/GamePage'
import { HomePage } from '../features/home/HomePage'
import { ImportFlow } from '../features/import/ImportFlow'
import { ImportReviewPage } from '../features/import/ImportReviewPage'
import { ImportUploadPage } from '../features/import/ImportUploadPage'
import { LeaderboardPage } from '../features/scores/LeaderboardPage'
import { TreePage } from '../features/search/TreePage'
import { Layout } from './Layout'
import { NotFoundPage } from './NotFoundPage'
import { RequireAuth } from './RequireAuth'

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: 'check-email', element: <CheckEmailPage /> },
      { path: 'verify-email', element: <VerifyEmailPage /> },
      { path: 'forgot-password', element: <ForgotPasswordPage /> },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      { path: 'leaderboard', element: <LeaderboardPage /> },
      {
        path: 'game/:gameId',
        element: (
          <RequireAuth>
            <GamePage />
          </RequireAuth>
        ),
      },
      {
        // Full-screen search tree, synced with the game tab (PLAN.md §5.5).
        path: 'game/:gameId/tree',
        element: (
          <RequireAuth>
            <TreePage />
          </RequireAuth>
        ),
      },
      {
        // Photo import (PLAN.md §5.6); the photo lives only in ImportFlow's state.
        path: 'import',
        element: (
          <RequireAuth>
            <ImportFlow />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <ImportUploadPage /> },
          { path: 'review', element: <ImportReviewPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]
