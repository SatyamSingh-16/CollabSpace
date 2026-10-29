import { defineConfig, devices } from '@playwright/test'

// Browser checks against a RUNNING deployment (deploy/compose.yaml): Nginx,
// TLS, the built frontend and the Go server, as users reach them. Not part
// of the default suite. Run with the stack up:
//   DEPLOY_URL=https://localhost:8443 npx playwright test -c playwright.deploy.config.ts
// ignoreHTTPSErrors: the local stack uses a private CA (deploy/gen-local-cert.sh).
// This proves the proxy and app work over HTTPS, not that a public
// certificate is trusted.
export default defineConfig({
  testDir: 'browser-deploy',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.DEPLOY_URL ?? 'https://localhost:8443',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
