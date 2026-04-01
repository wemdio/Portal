import 'server-only';
import { createClient } from '@supabase/supabase-js';

const url = process.env.INSTANTLY_SUPABASE_URL;
const key = process.env.INSTANTLY_SUPABASE_SERVICE_ROLE_KEY;

export const supabaseInstantly = url && key
  ? createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;
