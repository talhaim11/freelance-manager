import { defineConfig, devices } from '@playwright/test';

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
    { command: 'node scripts/static-server.mjs legacy 4173', port: 4173, reuseExistingServer: false },
    // The app is served WITHOUT Supabase variables so tests can only use demo mode.
    { command: 'npx vite --port 5173', port: 5173, reuseExistingServer: false,
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' } },
  ],
});
