import { setupWorker } from 'msw/browser'
import { enablePersistence } from './db'
import { handlers, setMockLatency } from './handlers'

/** Starts the in-browser mock API (only when VITE_USE_MOCKS=true). */
export async function startMockWorker(): Promise<void> {
  enablePersistence()
  setMockLatency(250)
  const worker = setupWorker(...handlers)
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: true,
  })
  console.info(
    '[mocks] MSW is serving /api/v1. Demo login: demo@example.com / password123. ' +
      'Verification and reset emails are printed here.',
  )
}
