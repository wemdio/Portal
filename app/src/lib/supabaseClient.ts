import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

function isValidHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const fallbackSupabaseUrl = 'http://127.0.0.1:54321';
const fallbackSupabaseAnonKey = 'missing-supabase-anon-key';
const resolvedSupabaseUrl = isValidHttpUrl(supabaseUrl)
  ? supabaseUrl
  : (isTestEnv ? 'http://localhost:54321' : fallbackSupabaseUrl);
const resolvedSupabaseAnonKey = supabaseAnonKey || (isTestEnv ? 'test-anon-key' : fallbackSupabaseAnonKey);

if (!isValidHttpUrl(supabaseUrl) || !supabaseAnonKey) {
  console.error(
    '[supabaseClient] Invalid/missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Check container env.',
  );
}

export const supabase = createBrowserClient(resolvedSupabaseUrl, resolvedSupabaseAnonKey);
