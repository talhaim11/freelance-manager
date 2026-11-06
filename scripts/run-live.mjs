// Runs both live suites (API + browser) against a real Supabase stack.
//   node scripts/run-live.mjs local   → local CLI stack (.env.live.local, from live-local-setup.mjs)
//   node scripts/run-live.mjs dev     → hosted development project (.env.live.dev.local)
import { spawnSync } from 'node:child_process';

const target = process.argv[2];
if (!['local', 'dev'].includes(target)) { console.error('usage: node scripts/run-live.mjs <local|dev>'); process.exit(1); }
const env = { ...process.env, FM_LIVE_ENV_FILE: target === 'dev' ? '.env.live.dev.local' : '.env.live.local' };
const run = (args) => spawnSync('npx', args, { stdio: 'inherit', env, shell: true }).status ?? 1;
// Fresh empty restore-target accounts for every run (restored accounts cannot be emptied again).
if (target === 'local') { const s = run(['node', 'scripts/live-local-setup.mjs']); if (s) process.exit(s); }
const api = run(['vitest', 'run', '-c', 'vitest.live.config.ts']);
const e2e = run(['playwright', 'test', '-c', 'playwright.live.config.ts']);
console.log(`\nlive (${target}): API suite ${api === 0 ? 'passed' : 'FAILED'}, browser suite ${e2e === 0 ? 'passed' : 'FAILED'}`);
process.exit(api || e2e);
