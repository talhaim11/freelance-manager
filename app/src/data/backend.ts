import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Only the public project URL and anon key belong in the frontend; access is
// enforced by row-level security and the allow-list. The service-role key must
// never be placed in any VITE_ variable.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const backendConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!backendConfigured) throw new Error('Supabase is not configured');
  if (!client) client = createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true, flowType: 'pkce' } });
  return client;
}
