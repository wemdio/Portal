import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildMessageId } from '@/lib/sender/template';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 20_000;

/**
 * POST — ответить лиду прямо из окна переписки (задача 4.1 хендоффа фич).
 *
 * Письмо уходит с закреплённого ящика лида (sticky sender — смена отправителя
 * посреди переписки выглядела бы чужим письмом), ложится в очередь и
 * отправляется воркером сендера: SMTP не ходит из API-процесса портала.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.reply' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return jsonError('Письмо пустое', 400);
    if (text.length > MAX_BODY_CHARS) return jsonError('Письмо слишком длинное', 400);

    const db = supabaseAdmin;
    const { data: recipient } = await db
      .from('sender_recipients')
      .select('id, campaign_id, email, mailbox_id, thread_message_id, status')
      .eq('id', id)
      .maybeSingle();
    if (!recipient) return jsonError('Переписка не найдена', 404);

    if (!recipient.mailbox_id) {
      return jsonError('У переписки ещё нет ящика-отправителя — ответить нельзя', 409);
    }
    const { data: mailbox } = await db
      .from('sender_mailboxes')
      .select('id, email, status, enabled')
      .eq('id', recipient.mailbox_id)
      .maybeSingle();
    if (!mailbox || mailbox.status !== 'verified' || !mailbox.enabled) {
      return jsonError('Ящик переписки недоступен — ответ уйдёт после починки ящика', 409);
    }

    // Тема и ветка: отвечаем в тот же тред — Re: к первому письму, In-Reply-To
    // на последнее входящее (а если входящих нет — на корень цепочки).
    const [{ data: firstMessage }, { data: lastReply }] = await Promise.all([
      db.from('sender_messages')
        .select('subject')
        .eq('recipient_id', id)
        .eq('step_no', 1)
        .maybeSingle(),
      db.from('sender_replies')
        .select('message_id')
        .eq('recipient_id', id)
        .eq('kind', 'human')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const firstSubject = (firstMessage as { subject?: string } | null)?.subject ?? '';
    const subject = /^re:/i.test(firstSubject) || !firstSubject
      ? firstSubject || 'Re: ваше письмо'
      : `Re: ${firstSubject}`;
    const inReplyTo = (lastReply as { message_id?: string } | null)?.message_id ?? recipient.thread_message_id ?? null;

    const { error } = await db.from('sender_manual_messages').insert({
      campaign_id: recipient.campaign_id,
      recipient_id: recipient.id,
      mailbox_id: recipient.mailbox_id,
      to_email: recipient.email,
      subject,
      body: text,
      message_id: buildMessageId(String(mailbox.email)),
      in_reply_to: inReplyTo,
      status: 'queued',
      created_by: auth.user.id,
    });
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({ ok: true });
  });
}
