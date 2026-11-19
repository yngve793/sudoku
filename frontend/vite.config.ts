/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Shell env wins; `.env*` files are not in process.env at config time, so read them too.
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_')
  const apiTarget =
    process.env.VITE_API_PROXY_TARGET ?? fileEnv.VITE_API_PROXY_TARGET ?? 'http://localhost:8000'

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        // The FastAPI backend serves everything under /api/v1.
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
      restoreMocks: true,
      coverage: {
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/mocks/**', 'src/main.tsx'],
      },
    },
  }
})
