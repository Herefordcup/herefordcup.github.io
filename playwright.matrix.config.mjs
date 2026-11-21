import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_WEB_PORT || 4174);

export default defineConfig({
  testDir: './e2e',
  testMatch: 'four-admin-scenarios.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    headless: true,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: 'node scripts/e2e/serve.mjs',
    url: `http://127.0.0.1:${port}/portal.html`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
