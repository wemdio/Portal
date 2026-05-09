import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOrCreateThread, listMessages } from '@/lib/clientSupport/threadStore';
import { markSupportNotificationsRead } from '@/lib/clientSupport/notify';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/support/thread
 *
 * Returns the client's single persistent support thread plus the last 200
 * messages, ordered oldest-first. The thread is created lazily on first call
 * so brand-new clients don't need an "open conversation" button — the page
 * just renders the empty state and they start typing.
 *
 * Side effect: marks every unread `support_message` notification pointing at
 * this thread as read for the calling client. The bell badge reflects that
 * the moment the user revisits /notifications.
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  const adminClient = supabaseAdmin;
  if (!adminClient) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  try {
    const thread = await getOrCreateThread(adminClient, userId);
    if (!thread) return jsonError('Не удалось загрузить тред', 500);

    const messages = await listMessages(adminClient, thread.id);

    // Fire-and-forget read marker — failure here is non-fatal for rendering.
    await markSupportNotificationsRead(adminClient, userId, thread.id);

    return NextResponse.json({ thread, messages });
  } catch (err) {
    await logError('client.support.thread.get.failed', err, { userId });
    return jsonError('Не удалось загрузить тред', 500);
  }
}
