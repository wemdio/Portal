import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOrCreateThread, appendMessageWithCache } from '@/lib/clientSupport/threadStore';
import { notifyManagersOfClientMessage } from '@/lib/clientSupport/notify';
import { sendSupportTelegramAlert } from '@/lib/clientSupport/telegramAlert';
import { validateMessageBody } from '@/lib/clientSupport/types';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * POST /api/client/support/messages
 * body: { body: string }
 *
 * Sends a message from the calling client into their (auto-created) support
 * thread. Triggers notification fanout to every admin/technician via
 * public.notifications so the in-portal bell icon picks it up.
 *
 * The thread is keyed by `client_user_id`, not by request body, so a
 * malicious client can't attempt to write into another client's conversation
 * via parameter tampering — there's no thread_id in the request at all.
 */
export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  const adminClient = supabaseAdmin;
  if (!adminClient) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonError('Некорректный JSON', 400);
  }

  const candidate = (payload as { body?: unknown } | null)?.body;
  const validation = validateMessageBody(candidate);
  if (!validation.ok) return jsonError(validation.error, 400);

  try {
    const thread = await getOrCreateThread(adminClient, userId);
    if (!thread) return jsonError('Не удалось открыть тред', 500);

    const message = await appendMessageWithCache(adminClient, {
      threadId: thread.id,
      senderUserId: userId,
      senderRole: 'client',
      body: validation.body,
    });
    if (!message) return jsonError('Не удалось сохранить сообщение', 500);

    // Pull the client's display name for the manager-side notification title.
    const { data: profile } = await adminClient
      .from('profiles')
      .select('full_name, email')
      .eq('id', userId)
      .maybeSingle();

    const clientDisplayName =
      (profile?.full_name as string | null)?.trim() ||
      (profile?.email as string | null) ||
      'клиент';

    // Fanout — non-blocking semantics: even if it fails the message is saved.
    await notifyManagersOfClientMessage({
      db: adminClient,
      threadId: thread.id,
      clientUserId: userId,
      clientDisplayName,
      body: validation.body,
    });

    // Real-time Telegram nudge to the operator (the bell icon is only polled, so
    // managers miss messages when the portal isn't open). Fire-and-forget: it
    // never throws, and a TG outage must not fail the client's send.
    void sendSupportTelegramAlert({
      clientDisplayName,
      body: validation.body,
      threadId: thread.id,
    });

    return NextResponse.json({ message, thread_id: thread.id });
  } catch (err) {
    await logError('client.support.messages.post.failed', err, { userId });
    return jsonError('Не удалось отправить сообщение', 500);
  }
}
