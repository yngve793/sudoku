import { defineConfig, devices } from '@playwright/test'

/**
 * By default the e2e suite starts the Vite dev server with in-browser MSW
 * mocks (VITE_USE_MOCKS=true). Set E2E_BASE_URL to run against an already
 * running stack instead (e.g. docker-compose with the real backend + Mailpit).
 */
const PORT = 5174
const externalBaseUrl = process.env.E2E_BASE_URL

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `npx vite --port ${PORT} --strictPort`,
        env: { VITE_USE_MOCKS: 'true' },
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
})
