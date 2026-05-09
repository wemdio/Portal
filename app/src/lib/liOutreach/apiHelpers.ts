// Re-export generic auth/error helpers used by all tools.
// These are tool-agnostic despite living under tgOutreach/.
export { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function checkIsAdmin(userId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  return data?.role === 'admin';
}
