import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/support/unread
 *
 * Lightweight unread-count for the «Поддержка» nav badge. Counts the same
 * public.notifications rows (type='support_message', entity_type='support_thread',
 * is_read=false) that GET /api/client/support/thread clears on open — so the
 * badge lights up the moment a manager replies and clears the moment the client
 * opens the thread. We `head: true` the query: only the count crosses the wire,
 * never the rows, because the nav polls this on an interval.
 *
 * Failure is non-fatal: a broken count must never break the sidebar, so we fall
 * back to `{ unread: 0 }` rather than surfacing a 500 the client UI would have
 * to special-case. The demo account has no real thread → always 0.
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return NextResponse.json({ unread: 0 });

  const adminClient = supabaseAdmin;
  if (!adminClient) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  try {
    const { count, error } = await adminClient
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('type', 'support_message')
      .eq('entity_type', 'support_thread')
      .eq('is_read', false);

    if (error) throw error;

    return NextResponse.json({ unread: count ?? 0 });
  } catch (err) {
    await logError('client.support.unread.get.failed', err, { userId });
    return NextResponse.json({ unread: 0 });
  }
}
