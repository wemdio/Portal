import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { importRecipients, SenderOpError, type ImportRecipientsResult } from '@/lib/sender/campaignOps';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { FileParseError, parseMailboxFile } from '@/lib/sender/fileParse';
import { recipientRowsFromFile, type RecipientInput } from '@/lib/sender/recipientImport';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
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
 * POST — загрузка базы получателей файлом (CSV/XLSX). Правила заливки — стоп-
 * лист, дубли, пустое первое письмо, замена базы (поле mode=replace) — в
 * campaignOps.importRecipients: той же функцией базу заливает автоаутрич.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.recipients.import' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id: campaignId } = await params;

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

    // Файл разбирается целиком до любых записей: битый файл при замене базы
    // не должен успеть стереть старую.
    let rows: RecipientInput[];
    let fileRows: number;
    try {
      const parsedFile = parseMailboxFile(file.name, Buffer.from(await file.arrayBuffer()));
      fileRows = parsedFile.totalRows;
      rows = recipientRowsFromFile(parsedFile.rows);
    } catch (e) {
      if (e instanceof FileParseError) return jsonError(e.message, 400);
      return jsonError(`Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
    }

    let result: ImportRecipientsResult;
    try {
      result = await importRecipients(campaignId, rows, { mode: replace ? 'replace' : 'append' });
    } catch (e) {
      if (e instanceof SenderOpError) return jsonError(e.message, e.status);
      throw e;
    }

    // Ни одной годной строки — importRecipients базу не трогал (при замене
    // тоже), остаётся объяснить почему.
    if (!result.accepted) {
      return jsonError(
        result.skippedEmptyLetter
          ? 'У всех адресов файла первое письмо выходит пустым — проверьте переменные в его тексте'
          : 'В файле не нашлось ни одного корректного адреса',
        400,
      );
    }

    return NextResponse.json({
      imported: result.inserted,
      replaced: replace,
      // Вместе с пустым первым письмом: такой строке письмо не уйдёт, как и
      // строке с плохим адресом. Отдельно — skippedEmptyLetter.
      skippedInvalid: result.skippedInvalid,
      skippedEmptyLetter: result.skippedEmptyLetter,
      skippedDuplicates: result.skippedDuplicates,
      skippedSuppressed: result.skippedSuppressed,
      // Обрез лимита виден человеку, а не молчит: «в файле 50 000, загружено 20 000».
      fileRows,
      truncated: fileRows > 20_000 ? 20_000 : null,
    });
  });
}
