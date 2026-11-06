import { defineConfig, devices } from '@playwright/test';
import { loadLiveTarget } from './tests/live/env';

// Browser tests against a REAL Supabase stack (local CLI stack or the dev project).
// The app is served with the publishable key only, on its own port.
const { target } = loadLiveTarget();
export const LIVE_PORT = 5175;

export default defineConfig({
  testDir: 'tests/live',
  testMatch: /.*\.e2e\.ts/,
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
  webServer: target && !process.env.FM_LIVE_BASE_URL ? {
    command: `npx vite --port ${LIVE_PORT} --strictPort --host`,
    port: LIVE_PORT,
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: target.url,
      VITE_SUPABASE_PUBLISHABLE_KEY: target.publishableKey,
      VITE_SUPABASE_ANON_KEY: '',
      VITE_APP_ENV_LABEL: target.kind === 'local' ? 'שרת מקומי (בדיקות)' : 'פיתוח',
    },
  } : undefined,
});
