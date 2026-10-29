import { defineConfig, devices } from '@playwright/test'

// Real-browser tests (Chromium). The Go server is started and restarted by
// the tests themselves (browser/workflow.spec.ts) on BACKEND_PORT; Vite serves
// the app on VITE_PORT and proxies /api and /ws to it, as in development.
export const VITE_PORT = 15173
export const BACKEND_PORT = 18080

export default defineConfig({
  testDir: 'browser',
  fullyParallel: false,
  workers: 1, // one shared server; tests restart it
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${VITE_PORT} --strictPort`,
    url: `http://localhost:${VITE_PORT}`,
    env: { COLLABSPACE_BACKEND: `127.0.0.1:${BACKEND_PORT}` },
    reuseExistingServer: false,
  },
})
