import 'server-only';
import { createClient } from '@supabase/supabase-js';

const url = process.env.INSTANTLY_SUPABASE_URL;
const key = process.env.INSTANTLY_SUPABASE_SERVICE_ROLE_KEY;

const isLocalPostgrest = url ? !url.includes('supabase.co') : false;

const postgrestFetch: typeof globalThis.fetch = (input, init) => {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const headers = new Headers(init?.headers);
  headers.delete('Authorization');
  headers.delete('apikey');
  return globalThis.fetch(raw.replace('/rest/v1', ''), { ...init, headers });
};

export const supabaseInstantly = url
  ? createClient(url, key ?? 'local-postgrest', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      ...(isLocalPostgrest ? { global: { fetch: postgrestFetch } } : {}),
    })
  : null;
