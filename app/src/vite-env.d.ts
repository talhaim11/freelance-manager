/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Legacy anon key (deprecated by Supabase by end of 2026). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_APP_ENV_LABEL?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
