import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { parseMailboxFile, FileParseError } from '@/lib/sender/fileParse';
import { parseMailboxRows } from '@/lib/sender/mailboxImport';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const LIST_COLS =
  'id, provider, auth_type, enabled, google_state, google_account, email, display_name, username, smtp_host, smtp_port, smtp_tls_mode, imap_host, imap_port, status, daily_campaign_limit, daily_total_limit, last_verified_at, last_error, last_send_at, imap_checked_at, directory_synced_at, created_at';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const PAGE_SIZE = 30;
/**
 * Потолок страницы для выбора ящиков в кампанию: там нужен не постраничный
 * список, а поиск по всей базе ящиков. Двести строк — это и весь пул средней
 * студии, и предел, за которым список в модалке всё равно перестают читать
 * глазами и начинают искать.
 */
const MAX_PAGE_SIZE = 200;

const BULK_ACTIONS = ['recheck', 'enable', 'disable', 'delete'] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];
// Потолок на выборку: он же ограничивает длину `in (...)` в запросе к БД.
// Страница списка — 30 ящиков, «выбрать все» на проекте с сотнями ящиков
// упрётся в этот предел раньше, чем в лимит запроса.
const MAX_BULK_IDS = 1000;

/** GET — список подключённых ящиков (без паролей), постранично. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(url.searchParams.get('pageSize') ?? '') || PAGE_SIZE),
    );
    // Запятые и скобки — синтаксис фильтров PostgREST, в адресе ящика им делать
    // нечего. Проценты и подчёркивания оставляем: как шаблон они безобидны.
    const search = (url.searchParams.get('search') ?? '').trim().replace(/[(),]/g, '').slice(0, 200);

    // Сортировка строго по email: батч-импорт даёт всем строкам одинаковое
    // created_at, и сортировка по нему дёргает список при каждом опросе
    // статусов — строки менялись местами каждые пару секунд.
    let query = supabaseAdmin
      .from('sender_mailboxes')
      .select(LIST_COLS, { count: 'exact' })
      .order('email', { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (search) query = query.ilike('email', `%${search}%`);

    const { data, error, count } = await query;

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ mailboxes: data ?? [], total: count ?? 0 });
  });
}

/**
 * PATCH — массовое действие над выбранными ящиками.
 *
 * Отдельный маршрут, а не цикл запросов из браузера: ящиков бывает несколько
 * сотен, и двести PATCH-ов подряд — это двести раундтрипов, двести проверок
 * доступа и список, который перерисовывается в процессе. Здесь одна операция
 * на всю выборку, и она либо прошла, либо нет.
 *
 * Повторная проверка и возврат в работу — это одно и то же: ящик снова
 * встаёт в очередь на вход по SMTP/IMAP и до успеха в рассылку не идёт.
 */
export async function PATCH(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.bulk' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as
      | { ids?: unknown; action?: unknown }
      | null;
    if (!body) return jsonError('Невалидный JSON', 400);

    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [];
    if (!ids.length) return jsonError('Не выбрано ни одного ящика', 400);
    if (ids.length > MAX_BULK_IDS) return jsonError(`За раз можно изменить не больше ${MAX_BULK_IDS} ящиков`, 400);

    const action = String(body.action ?? '');
    if (!BULK_ACTIONS.includes(action as BulkAction)) return jsonError('Неизвестное действие', 400);

    const nowIso = new Date().toISOString();

    if (action === 'delete') {
      const { error, count } = await supabaseAdmin
        .from('sender_mailboxes').delete({ count: 'exact' }).in('id', ids);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true, affected: count ?? 0 });
    }

    // «Использовать / не использовать» — это галочка enabled, а не состояние
    // проверки: снятая галочка не должна стирать то, что ящик уже проверен.
    const patch = action === 'disable'
      ? { enabled: false, updated_at: nowIso }
      : action === 'enable'
        ? { enabled: true, status: 'pending', last_error: null, updated_at: nowIso }
        : { status: 'pending', last_error: null, updated_at: nowIso };

    const { error, count } = await supabaseAdmin
      .from('sender_mailboxes').update(patch, { count: 'exact' }).in('id', ids);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true, affected: count ?? 0 });
  });
}

/**
 * POST — загрузка выгрузки провайдера (CSV/XLSX). Ящики сохраняются со
 * статусом «ожидает проверки»: вход по SMTP и IMAP проверяет воркер, иначе
 * загрузка сотни ящиков не уложилась бы в один HTTP-запрос.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.import' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError('Ожидается файл выгрузки', 400);
    }

    const file = form.get('file');
    if (!(file instanceof File)) return jsonError('Добавьте файл выгрузки (CSV или XLSX)', 400);
    if (file.size > MAX_FILE_BYTES) return jsonError('Файл больше 10 МБ', 400);

    let parsed;
    try {
      const rows = parseMailboxFile(file.name, Buffer.from(await file.arrayBuffer()));
      // Провайдер не спрашивается у человека: его определяет разбор — по
      // колонкам файла, шапке выгрузки и, если файл промолчал, по DNS домена.
      parsed = await parseMailboxRows(rows);
    } catch (e) {
      if (e instanceof FileParseError) return jsonError(e.message, 400);
      return jsonError(`Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
    }

    if (!parsed.mailboxes.length) {
      return NextResponse.json({ imported: 0, detected: {}, errors: parsed.errors }, { status: 200 });
    }

    const nowIso = new Date().toISOString();
    const rows = parsed.mailboxes.map((mailbox) => ({
      provider: mailbox.provider,
      email: mailbox.email,
      display_name: mailbox.displayName,
      username: mailbox.username,
      smtp_host: mailbox.smtpHost,
      smtp_port: mailbox.smtpPort,
      smtp_tls_mode: mailbox.smtpTlsMode,
      imap_host: mailbox.imapHost,
      imap_port: mailbox.imapPort,
      secret_encrypted: sealMailboxSecret({
        smtpPassword: mailbox.smtpPassword,
        imapPassword: mailbox.imapPassword ?? undefined,
      }),
      // Повторная загрузка того же файла обновляет пароль и хосты, но снова
      // отправляет ящик на проверку — креды могли смениться.
      status: 'pending',
      last_error: null,
      created_by: auth.user.id,
      updated_at: nowIso,
    }));

    const { data, error } = await supabaseAdmin
      .from('sender_mailboxes')
      .upsert(rows, { onConflict: 'email' })
      .select('id');

    if (error) return jsonError(error.message, 500);

    // Что именно распознал портал — видно человеку сразу после загрузки.
    // Раньше провайдера называл он сам, и ошибка выбора всплывала только на
    // проверке входа; теперь решение принимает портал, и оно должно быть на виду.
    const detected: Record<string, number> = {};
    for (const mailbox of parsed.mailboxes) {
      detected[mailbox.provider] = (detected[mailbox.provider] ?? 0) + 1;
    }

    return NextResponse.json({
      imported: data?.length ?? 0,
      detected,
      errors: parsed.errors,
    });
  });
}
