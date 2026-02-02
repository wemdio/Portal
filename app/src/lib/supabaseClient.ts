import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const isTestEnv = process.env.NODE_ENV === 'test';

const resolvedSupabaseUrl = supabaseUrl ?? (isTestEnv ? 'http://localhost:54321' : undefined);
const resolvedSupabaseAnonKey = supabaseAnonKey ?? (isTestEnv ? 'test-anon-key' : undefined);

if (!resolvedSupabaseUrl || !resolvedSupabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Please check your .env.local file.');
}

export const supabase = createBrowserClient(resolvedSupabaseUrl, resolvedSupabaseAnonKey);
