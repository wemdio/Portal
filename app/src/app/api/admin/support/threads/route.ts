import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSupportManagerAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { SupportThreadRow } from '@/lib/clientSupport/types';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

interface ThreadListItem extends SupportThreadRow {
  client_full_name: string | null;
  client_email: string | null;
  client_avatar_url: string | null;
  unread_count: number;
}

/**
 * GET /api/admin/support/threads
 *
 * Lists every client support thread, sorted by the most recently active first.
 * Each row is enriched with the client's display info plus an `unread_count`
 * scoped to the calling manager — that's how the /support nav badge knows how
 * many threads still need attention from THIS user (a thread can be "open"
 * but already read by some other manager).
 *
 * The unread counter reads `public.notifications` because that's the source of
 * truth for "did this manager open the thread yet". A manager who already
 * clicked a thread row has their notifications for it marked is_read=true.
 */
export async function GET(req: NextRequest) {
  const result = await requireSupportManagerAuth(req);
  if ('error' in result) return result.error;

  const adminClient = supabaseAdmin;
  if (!adminClient) return jsonError('Server misconfigured', 500);

  const managerId = result.auth.user.id;

  try {
    const { data: threads, error } = await adminClient
      .from('client_support_threads')
      .select('*')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      await logError('admin.support.threads.list.failed', error, { managerId });
      return jsonError('Не удалось загрузить треды', 500);
    }

    const rows = (threads ?? []) as SupportThreadRow[];
    if (rows.length === 0) {
      return NextResponse.json({ threads: [], total_unread: 0 });
    }

    const clientIds = Array.from(new Set(rows.map((t) => t.client_user_id)));

    const { data: profiles } = await adminClient
      .from('profiles')
      .select('id, full_name, email, avatar_url')
      .in('id', clientIds);

    const profileById = new Map<
      string,
      { full_name: string | null; email: string | null; avatar_url: string | null }
    >();
    for (const p of (profiles ?? []) as Array<{
      id: string;
      full_name: string | null;
      email: string | null;
      avatar_url: string | null;
    }>) {
      profileById.set(p.id, {
        full_name: p.full_name,
        email: p.email,
        avatar_url: p.avatar_url,
      });
    }

    // Single query: pull every unread notification for THIS manager that
    // points at any of these threads, then group by entity_id (== thread.id).
    const { data: unreadRows } = await adminClient
      .from('notifications')
      .select('entity_id')
      .eq('user_id', managerId)
      .eq('type', 'support_message')
      .eq('entity_type', 'support_thread')
      .eq('is_read', false);

    const unreadByThread = new Map<string, number>();
    for (const row of (unreadRows ?? []) as Array<{ entity_id: string | null }>) {
      const id = row.entity_id;
      if (!id) continue;
      unreadByThread.set(id, (unreadByThread.get(id) ?? 0) + 1);
    }

    const enriched: ThreadListItem[] = rows.map((t) => {
      const p = profileById.get(t.client_user_id);
      return {
        ...t,
        client_full_name: p?.full_name ?? null,
        client_email: p?.email ?? null,
        client_avatar_url: p?.avatar_url ?? null,
        unread_count: unreadByThread.get(t.id) ?? 0,
      };
    });

    let totalUnread = 0;
    for (const v of unreadByThread.values()) totalUnread += v;

    return NextResponse.json({ threads: enriched, total_unread: totalUnread });
  } catch (err) {
    await logError('admin.support.threads.list.failed', err, { managerId });
    return jsonError('Не удалось загрузить треды', 500);
  }
}
