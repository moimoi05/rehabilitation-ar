import { defineConfig, devices } from '@playwright/test'

// Start the project services separately, with a dedicated test PostgreSQL database.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5173',
    channel: 'chrome',
    permissions: ['camera'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
