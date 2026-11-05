// Fails if anything that looks like a secret appears in source or build output.
// Prints only file names and pattern names — never the matched values.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['app', 'legacy', 'supabase', 'scripts', 'dist-app', 'netlify.toml', 'vite.config.ts', '.env.example'];
const SKIP = new Set(['node_modules', '.git']);
const SELF = join('scripts', 'check-secrets.mjs');
const PATTERNS = [
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{10,}/],
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['Supabase service_role JWT', /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\./],
  ['Private key block', /-----BEGIN (RSA |EC )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
];

const files = [];
const walk = (p) => {
  if (!existsSync(p)) return;
  const s = statSync(p);
  if (s.isDirectory()) { for (const f of readdirSync(p)) if (!SKIP.has(f)) walk(join(p, f)); }
  else if (p !== SELF && s.size < 5_000_000) files.push(p);
};
ROOTS.forEach(walk);

let found = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const [name, re] of PATTERNS) if (re.test(text)) { console.error(`✗ ${f}: looks like a ${name}`); found++; }
}
console.log(found ? `${found} potential secret(s) found` : `✓ no secrets found in ${files.length} files`);
process.exit(found ? 1 : 0);
