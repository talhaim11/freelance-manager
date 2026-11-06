// Loads the target for the live (real Supabase) suites from .env.live.local or the
// environment. Refuses any target that is not explicitly marked as local or as the
// dedicated development project, so these tests can never write to production.
import { existsSync, readFileSync } from 'node:fs';

export interface Account { email: string; password: string }
export interface LiveTarget {
  kind: 'local' | 'dev';
  url: string;
  publishableKey: string;
  owner: Account;
  /** Optional second allow-listed account, used to prove owners are isolated from each other. */
  owner2: Account | null;
  outsider: Account;
  /** Empty allow-listed accounts for restore tests (each used once). */
  restore: Account[];
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function loadLiveTarget(): { target: LiveTarget | null; reason: string } {
  const file = process.env.FM_LIVE_ENV_FILE || '.env.live.local';
  const env = { ...readEnvFile(file), ...process.env } as Record<string, string | undefined>;
  const get = (k: string) => env[k]?.trim() || '';
  const url = get('FM_LIVE_SUPABASE_URL');
  const key = get('FM_LIVE_PUBLISHABLE_KEY');
  const kind = get('FM_LIVE_TARGET');
  if (!url || !key) return { target: null, reason: `no live target configured (${file})` };
  if (key.startsWith('sb_secret_') || /c2VydmljZV9yb2xl/.test(key)) {
    throw new Error('FM_LIVE_PUBLISHABLE_KEY holds a privileged key. The live tests only ever use the publishable key.');
  }
  const host = new URL(url).hostname;
  if (kind === 'local') {
    if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('FM_LIVE_TARGET=local but the URL is not local.');
  } else if (kind === 'dev') {
    const ref = get('FM_LIVE_DEV_PROJECT_REF');
    if (!ref || host !== `${ref}.supabase.co`) {
      throw new Error('FM_LIVE_TARGET=dev requires FM_LIVE_DEV_PROJECT_REF to match the URL (guards against pointing tests at production).');
    }
  } else {
    throw new Error('FM_LIVE_TARGET must be "local" or "dev".');
  }
  const acct = (p: string): Account | null => (get(`${p}_EMAIL`) && get(`${p}_PASSWORD`) ? { email: get(`${p}_EMAIL`), password: get(`${p}_PASSWORD`) } : null);
  const owner = acct('FM_LIVE_OWNER');
  const outsider = acct('FM_LIVE_OUTSIDER');
  if (!owner || !outsider) return { target: null, reason: `owner/outsider test accounts missing in ${file}` };
  const restore = [1, 2, 3, 4, 5, 6].map((i) => acct(`FM_LIVE_RESTORE_${i}`)).filter((a): a is Account => !!a);
  return { target: { kind: kind as 'local' | 'dev', url, publishableKey: key, owner, owner2: acct('FM_LIVE_OWNER2'), outsider, restore }, reason: '' };
}
