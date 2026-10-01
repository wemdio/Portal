import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeRecipientEmail } from '@/lib/sender/recipientImport';
import { buildMessageId } from '@/lib/mail/message';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 20_000;
/** Сколько тестов в минуту можно отправить с одного аккаунта портала. */
const MAX_PER_MINUTE = 5;

/**
 * Тестовое письмо себе: то же письмо кампании, но на свой адрес.
 *
 * Предпросмотр показывает текст на экране, а как письмо выглядит в почте
 * (ссылки, переносы, подпись, не улетело ли в спам) — видно только из самой
 * почты. Письмо уходит с выбранного ящика кампании и ложится в ту же очередь,
 * что и ручные ответы: SMTP ходит с sender-хоста, а не из API-процесса.
 *
 * Строка очереди заводится без кампании и получателя — проверять письмо
 * нужно и до того, как кампания создана.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.testSend' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const input = (await req.json().catch(() => null)) as {
      mailboxId?: unknown;
      to?: unknown;
      subject?: unknown;
      body?: unknown;
    } | null;

    const mailboxId = typeof input?.mailboxId === 'string' ? input.mailboxId : '';
    const to = normalizeRecipientEmail(typeof input?.to === 'string' ? input.to : '');
    const subject = typeof input?.subject === 'string' ? input.subject.trim() : '';
    const body = typeof input?.body === 'string' ? input.body.trim() : '';

    if (!mailboxId) return jsonError('Не выбран ящик для отправки', 400);
    if (!to) return jsonError('Укажите почту, на которую отправить тест', 400);
    if (!body) return jsonError('Письмо пустое', 400);
    if (body.length > MAX_BODY_CHARS) return jsonError('Письмо слишком длинное', 400);

    const db = supabaseAdmin;
    const { data: mailbox } = await db
      .from('sender_mailboxes')
      .select('id, email, status, enabled, egress_ip')
      .eq('id', mailboxId)
      .maybeSingle();
    if (!mailbox) return jsonError('Ящик не найден', 404);
    if (mailbox.status !== 'verified' || !mailbox.enabled) {
      return jsonError('Ящик не проверен или выключен — с него не отправить', 409);
    }
    // Письмо забирает воркер адреса, за которым закреплён ящик. Пока адреса
    // нет, строка просто лежала бы в очереди — лучше сказать сразу.
    if (!mailbox.egress_ip) {
      return jsonError('Ящику ещё не выдан адрес отправки — попробуйте через пару минут', 409);
    }

    // Тест ходит через ту же очередь, что и живая отправка: пачка тестов в
    // минуту сдвинула бы ответы лидам, поэтому ограничиваем.
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await db
      .from('sender_manual_messages')
      .select('id', { count: 'exact', head: true })
      .is('recipient_id', null)
      .eq('created_by', auth.user.id)
      .gte('created_at', since);
    if ((count ?? 0) >= MAX_PER_MINUTE) {
      return jsonError('Слишком много тестовых писем подряд — подождите минуту', 429);
    }

    const { data: queued, error } = await db
      .from('sender_manual_messages')
      .insert({
        campaign_id: null,
        recipient_id: null,
        mailbox_id: mailbox.id,
        to_email: to,
        subject: subject || 'Тестовое письмо',
        body,
        message_id: buildMessageId(String(mailbox.email)),
        status: 'queued',
        created_by: auth.user.id,
      })
      .select('id')
      .single();
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({ id: (queued as { id: string }).id, from: mailbox.email });
  });
}

/** GET ?id= — ушло ли тестовое письмо: форма ждёт ответа и показывает итог. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.testSend.status' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const id = req.nextUrl.searchParams.get('id') ?? '';
    if (!id) return jsonError('Не указано письмо', 400);

    const { data } = await supabaseAdmin
      .from('sender_manual_messages')
      .select('status, error, sent_at')
      .eq('id', id)
      .eq('created_by', auth.user.id)
      .is('recipient_id', null)
      .maybeSingle();
    if (!data) return jsonError('Тестовое письмо не найдено', 404);

    return NextResponse.json({ test: data });
  });
}
