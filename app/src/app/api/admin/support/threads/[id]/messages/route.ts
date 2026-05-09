import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSupportManagerAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { listMessages, appendMessageWithCache } from '@/lib/clientSupport/threadStore';
import {
  notifyClientOfManagerMessage,
  markSupportNotificationsRead,
} from '@/lib/clientSupport/notify';
import { validateMessageBody } from '@/lib/clientSupport/types';
import type { SupportThreadRow } from '@/lib/clientSupport/types';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/admin/support/threads/[id]/messages
 *
 * Returns the message list of a single thread plus the client's display
 * profile. Side effect: marks every unread `support_message` notification for
 * the calling manager pointing at this thread as read — opening the thread is
 * acknowledgement.
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  const result = await requireSupportManagerAuth(req);
  if ('error' in result) return result.error;

  const adminClient = supabaseAdmin;
  if (!adminClient) return jsonError('Server misconfigured', 500);

  const { id: threadId } = await ctx.params;
  const managerId = result.auth.user.id;

  try {
    const { data: thread, error } = await adminClient
      .from('client_support_threads')
      .select('*')
      .eq('id', threadId)
      .maybeSingle<SupportThreadRow>();

    if (error || !thread) return jsonError('Тред не найден', 404);

    const messages = await listMessages(adminClient, threadId);

    const { data: client } = await adminClient
      .from('profiles')
      .select('id, full_name, email, avatar_url')
      .eq('id', thread.client_user_id)
      .maybeSingle();

    await markSupportNotificationsRead(adminClient, managerId, threadId);

    return NextResponse.json({
      thread,
      messages,
      client: client
        ? {
            id: (client as { id: string }).id,
            full_name: (client as { full_name: string | null }).full_name,
            email: (client as { email: string | null }).email,
            avatar_url: (client as { avatar_url: string | null }).avatar_url,
          }
        : null,
    });
  } catch (err) {
    await logError('admin.support.thread.messages.get.failed', err, {
      managerId,
      threadId,
    });
    return jsonError('Не удалось загрузить сообщения', 500);
  }
}

/**
 * POST /api/admin/support/threads/[id]/messages
 * body: { body: string }
 *
 * Manager replies into the thread. Notifies the client (single row insert
 * into public.notifications). Other managers do NOT get notified about a
 * peer's outgoing reply — that would create noise during back-and-forth.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const result = await requireSupportManagerAuth(req);
  if ('error' in result) return result.error;

  const adminClient = supabaseAdmin;
  if (!adminClient) return jsonError('Server misconfigured', 500);

  const { id: threadId } = await ctx.params;
  const managerId = result.auth.user.id;

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
    const { data: thread, error } = await adminClient
      .from('client_support_threads')
      .select('*')
      .eq('id', threadId)
      .maybeSingle<SupportThreadRow>();

    if (error || !thread) return jsonError('Тред не найден', 404);

    const message = await appendMessageWithCache(adminClient, {
      threadId,
      senderUserId: managerId,
      senderRole: 'manager',
      body: validation.body,
    });
    if (!message) return jsonError('Не удалось сохранить сообщение', 500);

    const { data: managerProfile } = await adminClient
      .from('profiles')
      .select('full_name, email')
      .eq('id', managerId)
      .maybeSingle();

    const managerDisplayName =
      (managerProfile?.full_name as string | null)?.trim() ||
      (managerProfile?.email as string | null) ||
      'менеджер';

    await notifyClientOfManagerMessage({
      db: adminClient,
      threadId,
      clientUserId: thread.client_user_id,
      managerDisplayName,
      body: validation.body,
    });

    return NextResponse.json({ message });
  } catch (err) {
    await logError('admin.support.thread.messages.post.failed', err, {
      managerId,
      threadId,
    });
    return jsonError('Не удалось отправить сообщение', 500);
  }
}
