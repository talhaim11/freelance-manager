import { defineConfig, devices } from '@playwright/test';

// Demo-mode suite. FM_E2E_PORT / FM_E2E_LEGACY_PORT let it run while dev servers already use 5173 / 4173.
export const APP_PORT = Number(process.env.FM_E2E_PORT ?? 5173);
export const LEGACY_PORT = Number(process.env.FM_E2E_LEGACY_PORT ?? 4173);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', locale: 'he-IL', timezoneId: 'Asia/Jerusalem' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: [
    { command: `node scripts/static-server.mjs legacy ${LEGACY_PORT}`, port: LEGACY_PORT, reuseExistingServer: false },
    // The app is served WITHOUT Supabase variables so tests can only use demo mode.
    { command: `npx vite --port ${APP_PORT} --strictPort`, port: APP_PORT, reuseExistingServer: false,
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_SUPABASE_ANON_KEY: '' } },
  ],
});
