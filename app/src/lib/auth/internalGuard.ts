import { isInternalRole } from '@/lib/roles';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserRole } from '@/types';

/**
 * True if `userId` is an internal (staff) role AND not a demo account.
 *
 * Internal tools live under /api/tools/*, /api/ai-caller/*, /api/sales-copilot/* —
 * none reachable from the client portal UI. But middleware does NOT gate /api/* by
 * role, and these routes historically only did getUser() with no role check, so a
 * client/demo JWT could call them directly (e.g. self-create an ai_campaign and
 * place a real VAPI call — ai_campaigns RLS is ownership-based for any
 * `authenticated` user). This guard enforces the staff-only boundary at the API
 * layer. Reads profiles via the caller's own (RLS-scoped) client — every user can
 * read their own profile row. Fail-closed: missing row / demo flag => false.
 */
export async function isInternalUser(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('profiles')
    .select('role, is_demo')
    .eq('id', userId)
    .single();
  if (!data || data.is_demo === true) return false;
  return isInternalRole((data.role ?? null) as UserRole | null);
}
