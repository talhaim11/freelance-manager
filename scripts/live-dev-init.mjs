// Prepares .env.live.dev.local (git-ignored) for running the live suites against
// the hosted DEVELOPMENT project. Reads the project URL and publishable key from
// .env.local, generates strong passwords for two synthetic test accounts, and
// prints only what you need for the dashboard: the two e-mail addresses and the
// allow-list SQL. Passwords stay in the file (open it to copy them); they are not printed.
//
//   node scripts/live-dev-init.mjs you@example.com
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const base = (process.argv[2] || '').trim().toLowerCase();
if (!/^[^@\s+]+@[^@\s]+\.[^@\s]+$/.test(base)) {
  console.error('usage: node scripts/live-dev-init.mjs <your e-mail>   (test accounts become you+fm-test-…@domain)');
  process.exit(1);
}
const OUT = '.env.live.dev.local';
if (existsSync(OUT) && !process.argv.includes('--force')) {
  console.error(`${OUT} already exists. Re-run with --force to generate new passwords.`);
  process.exit(1);
}
const env = Object.fromEntries((existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '').split(/\r?\n/)
  .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) { console.error('.env.local must contain VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY first.'); process.exit(1); }
if (key.startsWith('sb_secret_')) { console.error('.env.local holds a SECRET key. Replace it with the publishable key.'); process.exit(1); }
const ref = new URL(url).hostname.split('.')[0];

const [user, domain] = base.split('@');
const pw = () => randomBytes(18).toString('base64url') + 'a1';
const owner = { email: `${user}+fm-test-owner@${domain}`, password: pw() };
const outsider = { email: `${user}+fm-test-outsider@${domain}`, password: pw() };
writeFileSync(OUT, [
  '# Live tests against the hosted DEVELOPMENT project. Git-ignored. Synthetic accounts only.',
  'FM_LIVE_TARGET=dev', `FM_LIVE_DEV_PROJECT_REF=${ref}`, `FM_LIVE_SUPABASE_URL=${url}`, `FM_LIVE_PUBLISHABLE_KEY=${key}`,
  `FM_LIVE_OWNER_EMAIL=${owner.email}`, `FM_LIVE_OWNER_PASSWORD=${owner.password}`,
  `FM_LIVE_OUTSIDER_EMAIL=${outsider.email}`, `FM_LIVE_OUTSIDER_PASSWORD=${outsider.password}`, '',
].join('\n'));

console.log(`✓ wrote ${OUT} for project ${ref}`);
console.log('\nCreate these two users in Authentication → Users → Add user (Auto Confirm), with the passwords from the file:');
console.log(`  ${owner.email}    (FM_LIVE_OWNER_PASSWORD)`);
console.log(`  ${outsider.email}    (FM_LIVE_OUTSIDER_PASSWORD)  — must NOT be allow-listed`);
console.log('\nThen run in the SQL Editor:');
console.log(`  insert into app.allowed_users(email) values ('${base}'), ('${owner.email}') on conflict do nothing;`);
