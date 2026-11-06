import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Only the public project URL and the publishable (or legacy anon) key belong in
// the frontend; access is enforced by row-level security and the allow-list.
// A secret / service_role key must never reach the browser: if one is configured
// by mistake, the app refuses to use it (and shows why) instead of connecting.
const env = import.meta.env;
const url = (env.VITE_SUPABASE_URL as string | undefined)?.trim() || undefined;
const key = ((env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) || (env.VITE_SUPABASE_ANON_KEY as string | undefined))?.trim() || undefined;

/** Returns why a configured key must not be used in a browser, or null if it is a public key. */
export function privilegedKeyProblem(k: string): string | null {
  if (k.startsWith('sb_secret_')) return 'secret';
  if (k.startsWith('eyJ')) {
    try {
      const payload = JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role && payload.role !== 'anon') return 'service_role';
    } catch { return 'unreadable'; }
  }
  return null;
}

export type BackendState =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: 'privileged_key' | 'bad_url' }
  | { kind: 'ready' };

function computeState(): BackendState {
  if (!url || !key) return { kind: 'none' };
  if (privilegedKeyProblem(key)) return { kind: 'invalid', reason: 'privileged_key' };
  try { new URL(url); } catch { return { kind: 'invalid', reason: 'bad_url' }; }
  return { kind: 'ready' };
}

export const backendState = computeState();
export const backendConfigured = backendState.kind === 'ready';

/** Human label for where cloud data lives, e.g. "שרת מקומי (פיתוח)" or "סביבת פיתוח · abcd". */
/**
 * An emailed recovery/invite link lands on the app with tokens in the URL fragment
 * (#access_token=…&type=recovery). Consume them once, before the hash router sees them,
 * and remove them from the address bar and history.
 */
export async function consumeAuthLinkFromUrl(): Promise<'recovery' | null> {
  const h = window.location.hash.replace(/^#/, '');
  if (!/(^|&)access_token=/.test(h)) return null;
  const q = new URLSearchParams(h);
  const type = q.get('type');
  history.replaceState(null, '', window.location.pathname + '#/');
  const access_token = q.get('access_token'), refresh_token = q.get('refresh_token');
  if (!access_token || !refresh_token || !backendConfigured) return null;
  const { error } = await supabase().auth.setSession({ access_token, refresh_token });
  if (error) return null;
  return type === 'recovery' || type === 'invite' || type === 'magiclink' ? 'recovery' : null;
}

export function backendLabel(): string {
  if (!url) return '';
  const host = new URL(url).hostname;
  const envLabel = (env.VITE_APP_ENV_LABEL as string | undefined)?.trim();
  if (host === 'localhost' || host === '127.0.0.1' || /^192\.168\.|^10\./.test(host)) return envLabel || 'שרת מקומי (פיתוח)';
  const ref = host.split('.')[0];
  return `${envLabel || 'ענן'} · ${ref.slice(0, 6)}`;
}

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!backendConfigured) throw new Error('Supabase is not configured');
  if (!client) client = createClient(url!, key!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  return client;
}
