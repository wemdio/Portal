import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildMessageId } from '@/lib/mail/message';
import { loadReferredEmails, resolveReplyTargets } from '@/lib/senderReplies/referred';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 20_000;

/**
 * POST — ответить лиду прямо из окна переписки (задача 4.1 хендоффа фич).
 *
 * Письмо уходит с закреплённого ящика лида (sticky sender — смена отправителя
 * посреди переписки выглядела бы чужим письмом), ложится в очередь и
 * отправляется воркером сендера: SMTP не ходит из API-процесса портала.
 *
 * «Кому» (toEmail, ccEmails): адресат прислал новый контакт — пишем ему
 * отдельным письмом с того же ящика или лиду в тред с ним в копии. Адрес
 * принимаем, только если он есть в последнем ответе адресата.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.reply' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as
      | { text?: unknown; draftId?: unknown; toEmail?: unknown; ccEmails?: unknown }
      | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    // Черновик ИИ, из которого вырос ответ: отмечаем его отправленным, чтобы
    // по истории было видно, ушёл ли текст ИИ и с какими правками.
    const draftId = typeof body?.draftId === 'string' && body.draftId ? body.draftId : null;
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

    const referred = await loadReferredEmails(db, recipient.id, [recipient.email, mailbox.email]);
    const targets = resolveReplyTargets({ referred, leadEmail: String(recipient.email), toEmail: body?.toEmail, ccEmails: body?.ccEmails });
    if ('error' in targets) return jsonError(targets.error, 422);
    const { newContact, cc } = targets;

    // Новый контакт и копия — люди, которым кампания не писала: стоп-лист
    // проверяем здесь, планировщик цепочки их не видел.
    const extra = [...(newContact ? [newContact] : []), ...cc];
    if (extra.length) {
      const [{ data: globalStop }, { data: campaignStop }] = await Promise.all([
        db.from('sender_suppressions').select('email').in('email', extra),
        db.from('sender_campaign_suppressions').select('email').eq('campaign_id', recipient.campaign_id).in('email', extra),
      ]);
      const blocked = [...(globalStop ?? []), ...(campaignStop ?? [])].map((r) => String(r.email));
      if (blocked.length) return jsonError(`Адрес ${blocked[0]} в стоп-листе — писать на него нельзя`, 409);
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
    const replySubject = /^re:/i.test(firstSubject) || !firstSubject
      ? firstSubject || 'Re: ваше письмо'
      : `Re: ${firstSubject}`;
    const inReplyTo = (lastReply as { message_id?: string } | null)?.message_id ?? recipient.thread_message_id ?? null;
    // Новому контакту — первое письмо ему: без «Re:» и вне треда лида, где
    // он не участвовал.
    const subject = newContact ? firstSubject.replace(/^(re:\s*)+/i, '').trim() || replySubject : replySubject;

    const { data: inserted, error } = await db.from('sender_manual_messages').insert({
      campaign_id: recipient.campaign_id,
      recipient_id: recipient.id,
      mailbox_id: recipient.mailbox_id,
      to_email: newContact ?? recipient.email,
      cc_emails: cc,
      subject,
      body: text,
      message_id: buildMessageId(String(mailbox.email)),
      in_reply_to: newContact ? null : inReplyTo,
      status: 'queued',
      created_by: auth.user.id,
    }).select('id').single();
    if (error) return jsonError(error.message, 500);

    if (draftId) {
      await db
        .from('sender_reply_drafts')
        .update({ status: 'sent', sent_at: new Date().toISOString(), manual_message_id: inserted.id })
        .eq('id', draftId)
        .eq('recipient_id', recipient.id);
    }

    return NextResponse.json({ ok: true, messageId: inserted.id });
  });
}
