import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSupportManagerAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { markSupportNotificationsRead } from '@/lib/clientSupport/notify';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/admin/support/threads/[id]/read
 *
 * Idempotent. Marks every unread `support_message` notification pointing at
 * this thread as read for the calling manager. The GET on the messages
 * endpoint also does this, but there are paths in the UI (focus-only,
 * keyboard navigation between threads) where we want to ack a thread without
 * pulling its full message list — for instance, when the manager scrolls
 * past it after answering a different one.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const result = await requireSupportManagerAuth(req);
  if ('error' in result) return result.error;

  const adminClient = supabaseAdmin;
  if (!adminClient) return jsonError('Server misconfigured', 500);

  const { id: threadId } = await ctx.params;
  const managerId = result.auth.user.id;

  try {
    await markSupportNotificationsRead(adminClient, managerId, threadId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    await logError('admin.support.thread.read.failed', err, { managerId, threadId });
    return jsonError('Не удалось отметить прочитанным', 500);
  }
}
