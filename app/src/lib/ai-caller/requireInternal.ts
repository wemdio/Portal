import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { isInternalRole } from '@/lib/roles';
import type { UserRole } from '@/types';

/**
 * Guard for AI-caller endpoints that perform real outward actions (phone calls,
 * Telegram sends) or paid work. The HTTP routes only do getUser() with no role
 * check, and ai_campaigns RLS is ownership-based for ANY `authenticated` user —
 * so a client/demo JWT could otherwise self-create a campaign and trigger a real
 * VAPI call. AI-caller is an internal (admin/staff) tool, so enforce internal
 * role at the API layer here.
 *
 * Returns an error NextResponse if the caller must be blocked, or null if allowed.
 */
export async function blockNonInternal(req: NextRequest): Promise<NextResponse | null> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_demo')
    .eq('id', user.id)
    .single();

  const role = (profile?.role ?? null) as UserRole | null;
  if (profile?.is_demo === true || !isInternalRole(role)) {
    return NextResponse.json({ error: 'Forbidden', code: 'INTERNAL_ONLY' }, { status: 403 });
  }
  return null;
}
