import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.HIRMOS_E2E_ORIGIN ?? 'http://127.0.0.1:3013',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
});
