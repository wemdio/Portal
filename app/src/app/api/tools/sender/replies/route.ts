import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

/**
 * GET — входящие письма, которые не удалось связать с получателем кампании.
 *
 * Ответ привязывается к переписке по ссылке на наше письмо (In-Reply-To) или по
 * адресу отправителя. Не сработает ни то, ни другое — когда человек отвечает с
 * другого ящика и новым письмом, а не «ответом», — и письмо остаётся лежать в
 * базе невидимым. Для получателя это полноценный ответ, поэтому такие письма
 * показываются отдельным блоком на вкладке «Письма», а не прячутся.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.replies.unlinked' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

    const { data, error, count } = await supabaseAdmin
      .from('sender_replies')
      .select('id, from_email, from_name, subject, body, kind, received_at, created_at, sender_mailboxes(email)', {
        count: 'exact',
      })
      .is('recipient_id', null)
      // Прогрев и отбойники сюда не относятся: первое — служебный шум чужих
      // прогревочных сетей, второе разбирается само (адрес уходит в стоп-лист).
      .in('kind', ['human', 'auto_reply', 'unknown'])
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    if (error) return jsonError(error.message, 500);

    const replies = (data ?? []).map((row) => {
      // Вложенная запись приезжает объектом или массивом — приводим к одному виду.
      const raw = (row as { sender_mailboxes?: unknown }).sender_mailboxes;
      const mailbox = (Array.isArray(raw) ? raw[0] : raw) as { email?: string } | null | undefined;
      return {
        id: String(row.id),
        fromEmail: row.from_email,
        fromName: row.from_name,
        subject: row.subject,
        body: row.body,
        kind: row.kind,
        at: (row.received_at ?? row.created_at) as string | null,
        mailboxEmail: mailbox?.email ?? null,
      };
    });

    return NextResponse.json({ replies, total: count ?? 0, pageSize: PAGE_SIZE });
  });
}
