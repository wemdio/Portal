import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const LIST_COLS =
  'recipient_id, campaign_id, campaign_name, recipient_email, recipient_name, status, replied_at, '
  + 'mailbox_id, mailbox_email, sent_count, last_sent_at, reply_count, last_reply_at, has_human_reply, last_activity_at';

const PAGE_SIZE = 30;

/**
 * GET — список переписок, сверху свежие.
 *
 * Считает и сортирует представление public.sender_threads: «последнее событие»
 * — это максимум из нашего письма и его ответа, и собирать это в приложении
 * значило бы тянуть в память все строки только ради порядка.
 *
 * Фильтры campaignId и mailboxId — это режим «по кампаниям» на вкладке: выбрали
 * кампанию, выбрали её ящик, увидели переписки именно с него.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const campaignId = url.searchParams.get('campaignId') ?? '';
    const mailboxId = url.searchParams.get('mailboxId') ?? '';
    const onlyReplied = url.searchParams.get('onlyReplied') === '1';
    // Скобки и запятые — синтаксис фильтров PostgREST; в адресе им делать нечего.
    const search = (url.searchParams.get('search') ?? '').trim().replace(/[(),]/g, '').slice(0, 200);

    let query = supabaseAdmin
      .from('sender_threads')
      .select(LIST_COLS, { count: 'exact' })
      .order('last_activity_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    if (campaignId) query = query.eq('campaign_id', campaignId);
    if (mailboxId) query = query.eq('mailbox_id', mailboxId);
    // «С ответами» = ответ живого человека. Счётчик ответов включает автоответы
    // и прогрев — фильтр по нему показывал бы пустые диалоги как «с ответами».
    if (onlyReplied) query = query.eq('has_human_reply', true);
    if (search) query = query.ilike('recipient_email', `%${search}%`);

    const { data, error, count } = await query;
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({ threads: data ?? [], total: count ?? 0, pageSize: PAGE_SIZE });
  });
}
