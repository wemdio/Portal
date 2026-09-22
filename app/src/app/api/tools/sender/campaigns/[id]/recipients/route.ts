import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { FileParseError, parseMailboxFile } from '@/lib/sender/fileParse';
import { parseRecipientRows } from '@/lib/sender/recipientImport';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const INSERT_CHUNK = 500;
const PAGE_SIZE = 30;

const STATUS_LABELS: Record<string, string> = {
  active: 'в работе',
  replied: 'ответил',
  bounced: 'отбой',
  unsubscribed: 'отписался',
  finished: 'пройден',
  stopped: 'стоп-лист',
};

/**
 * GET — база получателей кампании постранично (задача 5.2 хендоффа фич).
 *
 * Раньше о базе говорили только сводные цифры; «кому отправлено, кто ответил,
 * кто отбился» посмотреть было негде. Список читается по страницам с поиском
 * и фильтром по статусу.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.recipients.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const status = url.searchParams.get('status') ?? '';
    // Скобки и запятые — синтаксис PostgREST; в адресе им делать нечего.
    const search = (url.searchParams.get('search') ?? '').trim().replace(/[(),]/g, '').slice(0, 200);

    let query = supabaseAdmin
      .from('sender_recipients')
      .select('id, email, name, status, last_step_sent, replied_at, updated_at, sender_mailboxes(email)', {
        count: 'exact',
      })
      .eq('campaign_id', id)
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    if (status && STATUS_LABELS[status]) query = query.eq('status', status);
    if (search) query = query.ilike('email', `%${search}%`);

    const { data, error, count } = await query;
    if (error) return jsonError(error.message, 500);

    const recipients = (data ?? []).map((row) => {
      const raw = (row as { sender_mailboxes?: unknown }).sender_mailboxes;
      const mailbox = (Array.isArray(raw) ? raw[0] : raw) as { email?: string } | null | undefined;
      return {
        id: String(row.id),
        email: row.email,
        name: row.name,
        status: row.status,
        statusLabel: STATUS_LABELS[String(row.status)] ?? String(row.status),
        lastStepSent: row.last_step_sent,
        repliedAt: row.replied_at,
        updatedAt: row.updated_at,
        mailboxEmail: mailbox?.email ?? null,
      };
    });

    return NextResponse.json({ recipients, total: count ?? 0, pageSize: PAGE_SIZE });
  });
}

/**
 * POST — загрузка базы получателей файлом (CSV/XLSX).
 * Адреса из стоп-листа в кампанию не попадают, повторная загрузка того же
 * файла не создаёт дублей: адрес уникален в пределах кампании.
 *
 * Поле mode=replace заменяет базу, а не дополняет: из кампании уходят только
 * те, кому ещё ничего не планировали и не отправляли. Переписки замена не
 * трогает — иначе «перезалить базу» означало бы потерять историю по тем, кто
 * уже получил письмо и, может быть, ответил.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.recipients.import' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id: campaignId } = await params;
    const { data: campaign } = await supabaseAdmin
      .from('sender_campaigns')
      .select('id, status')
      .eq('id', campaignId)
      .maybeSingle();
    if (!campaign) return jsonError('Кампания не найдена', 404);
    // База, долитая в уже идущую кампанию, должна поехать сразу: у черновика
    // очередь выставляется в момент запуска.
    const nextStepAt = campaign.status === 'running' ? new Date().toISOString() : null;

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError('Ожидается файл с получателями', 400);
    }

    const file = form.get('file');
    if (!(file instanceof File)) return jsonError('Добавьте файл базы (CSV или XLSX)', 400);
    if (file.size > MAX_FILE_BYTES) return jsonError('Файл больше 20 МБ', 400);

    const replace = String(form.get('mode') ?? '') === 'replace';
    if (replace && !['draft', 'paused'].includes(String(campaign.status))) {
      return jsonError('Заменить базу можно у черновика или остановленной кампании', 409);
    }

    // Чистим до разбора файла, но после проверок статуса: если файл окажется
    // битым, старую базу уже не вернуть, поэтому разбираем его первым делом.
    let parsed;
    let fileRows: number;
    try {
      const parsedFile = parseMailboxFile(file.name, Buffer.from(await file.arrayBuffer()));
      fileRows = parsedFile.totalRows;
      parsed = parseRecipientRows(parsedFile.rows);
    } catch (e) {
      if (e instanceof FileParseError) return jsonError(e.message, 400);
      return jsonError(`Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
    }

    if (!parsed.recipients.length) {
      return jsonError('В файле не нашлось ни одного корректного адреса', 400);
    }

    if (replace) {
      // mailbox_id проставляется ровно в тот момент, когда планировщик завёл
      // письмо, поэтому «пустой ящик и нулевой шаг» — это и есть «мы к нему
      // ещё не прикасались».
      const { error: wipeError } = await supabaseAdmin
        .from('sender_recipients')
        .delete()
        .eq('campaign_id', campaignId)
        .eq('last_step_sent', 0)
        .is('mailbox_id', null);
      if (wipeError) return jsonError(wipeError.message, 500);
    }

    const emails = parsed.recipients.map((r) => r.email);
    const suppressed = new Set<string>();
    for (let i = 0; i < emails.length; i += INSERT_CHUNK) {
      const { data } = await supabaseAdmin
        .from('sender_suppressions')
        .select('email')
        .in('email', emails.slice(i, i + INSERT_CHUNK));
      for (const row of data ?? []) suppressed.add(String(row.email));
    }

    const rows = parsed.recipients
      .filter((recipient) => !suppressed.has(recipient.email))
      .map((recipient) => ({
        campaign_id: campaignId,
        email: recipient.email,
        name: recipient.name,
        vars: recipient.vars,
        status: 'active',
        next_step_at: nextStepAt,
      }));

    let imported = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const { data, error } = await supabaseAdmin
        .from('sender_recipients')
        .upsert(chunk, { onConflict: 'campaign_id,email', ignoreDuplicates: true })
        .select('id');
      if (error) return jsonError(error.message, 500);
      imported += data?.length ?? 0;
    }

    return NextResponse.json({
      imported,
      replaced: replace,
      skippedInvalid: parsed.invalid,
      skippedDuplicates: parsed.duplicates,
      skippedSuppressed: suppressed.size,
      // Обрез лимита виден человеку, а не молчит: «в файле 50 000, загружено 20 000».
      fileRows,
      truncated: fileRows > 20_000 ? 20_000 : null,
    });
  });
}
