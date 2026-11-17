import { defineConfig, devices } from '@playwright/test';

// Runs against `npm run dev` with CALENDAR_MODE=fake in .dev.vars, so the
// flow books into the in-memory calendar, never a real one.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // One shared calendar: parallel runs would race for the same slot (which the
  // app handles correctly, but the test would read as a failure).
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
    // The host's own zone, so every open time is inside the visitor's hours
    // unless a test says otherwise (e2e/hours.spec.ts).
    timezoneId: 'America/New_York',
    locale: 'en-US',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
