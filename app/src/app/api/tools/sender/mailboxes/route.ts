import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { parseMailboxFile, FileParseError } from '@/lib/sender/fileParse';
import { parseMailboxRows } from '@/lib/sender/mailboxImport';
import { isIpv4 } from '@/lib/sender/egress';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const LIST_COLS =
  'id, provider, auth_type, enabled, google_state, google_account, email, display_name, username, smtp_host, smtp_port, smtp_tls_mode, imap_host, imap_port, status, daily_campaign_limit, daily_total_limit, last_verified_at, last_error, last_send_at, imap_checked_at, directory_synced_at, created_at, tag_id, egress_ip, sender_mailbox_tags(id, name)';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const PAGE_SIZE = 30;
/**
 * Потолок страницы для выбора ящиков в кампанию: там нужен не постраничный
 * список, а поиск по всей базе ящиков. Двести строк — это и весь пул средней
 * студии, и предел, за которым список в модалке всё равно перестают читать
 * глазами и начинают искать.
 */
const MAX_PAGE_SIZE = 200;

const BULK_ACTIONS = ['recheck', 'enable', 'disable', 'delete', 'tag', 'move'] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];
// Потолок на выборку: он же ограничивает длину `in (...)` в запросе к БД.
// Страница списка — 30 ящиков, «выбрать все» на проекте с сотнями ящиков
// упрётся в этот предел раньше, чем в лимит запроса.
const MAX_BULK_IDS = 1000;
// Фильтр по тегам уходит в запрос списком id — принимаем только настоящие uuid
// и разумное их количество, чтобы параметр адреса не стал дырой в фильтре.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAG_FILTER = 50;

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

    // Отбор по тегу делает база, а не браузер: на экране лежит одна страница
    // из всего пула, и фильтрация на клиенте показывала бы только те совпадения,
    // которые случайно попали на текущую страницу.
    // tagIds и noTag складываются: «ящики тега А или вообще без тега».
    const tagIds = (url.searchParams.get('tagIds') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => UUID_RE.test(id))
      .slice(0, MAX_TAG_FILTER);
    const noTag = url.searchParams.get('noTag') === '1';

    if (tagIds.length && noTag) {
      query = query.or(`tag_id.in.(${tagIds.join(',')}),tag_id.is.null`);
    } else if (tagIds.length) {
      query = query.in('tag_id', tagIds);
    } else if (noTag) {
      query = query.is('tag_id', null);
    }

    // Фильтр по адресу отправки: 'none' — ящики, которым адрес ещё не выдан.
    const egressFilter = url.searchParams.get('egressIp') ?? '';
    if (egressFilter === 'none') query = query.is('egress_ip', null);
    else if (isIpv4(egressFilter)) query = query.eq('egress_ip', egressFilter);

    const { data, error, count } = await query;

    if (error) return jsonError(error.message, 500);

    // Вложенный тег приезжает объектом или массивом в зависимости от того, как
    // PostgREST разобрал связь, — на выходе всегда один объект или null.
    const mailboxes = (data ?? []).map((row) => {
      const { sender_mailbox_tags: raw, ...rest } = row as Record<string, unknown>;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const tag = list[0] as { id?: string; name?: string } | undefined;
      return {
        ...rest,
        tag: tag?.id && tag.name ? { id: String(tag.id), name: String(tag.name) } : null,
      };
    });

    // Последняя проверочная отправка по ящикам страницы: одну строку на ящик
    // (свежайшую), чтобы карточка сразу показывала, не переписывает ли
    // провайдер заголовки.
    const probeByMailbox = new Map<string, { status: string; passed: boolean | null; error: string | null; at: string }>();
    const pageIds = mailboxes.map((m) => String((m as { id?: string }).id)).filter(Boolean);
    if (pageIds.length) {
      const { data: probeRows } = await supabaseAdmin
        .from('sender_send_probes')
        .select('mailbox_id, status, passed, error, created_at')
        .in('mailbox_id', pageIds)
        .order('created_at', { ascending: false })
        .limit(pageIds.length * 3);
      for (const row of (probeRows ?? []) as { mailbox_id: string; status: string; passed: boolean | null; error: string | null; created_at: string }[]) {
        if (!probeByMailbox.has(row.mailbox_id)) {
          probeByMailbox.set(row.mailbox_id, { status: row.status, passed: row.passed, error: row.error, at: row.created_at });
        }
      }
    }

    return NextResponse.json({
      mailboxes: mailboxes.map((mailbox) => ({
        ...mailbox,
        probe: probeByMailbox.get(String((mailbox as { id?: string }).id)) ?? null,
      })),
      total: count ?? 0,
    });
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
      | { ids?: unknown; action?: unknown; tagId?: unknown; egressIp?: unknown }
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

    // «Под тег» — один ящик, один тег: новый просто встаёт на место старого,
    // а tagId === null снимает метку.
    if (action === 'tag') {
      const tagId = body.tagId == null ? null : String(body.tagId);
      if (tagId !== null && !UUID_RE.test(tagId)) return jsonError('Неизвестный тег', 400);
      if (tagId) {
        const { data: tag } = await supabaseAdmin
          .from('sender_mailbox_tags').select('id').eq('id', tagId).maybeSingle();
        if (!tag) return jsonError('Тег не найден', 404);
      }
      const { error, count } = await supabaseAdmin
        .from('sender_mailboxes')
        .update({ tag_id: tagId, updated_at: nowIso }, { count: 'exact' })
        .in('id', ids);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true, affected: count ?? 0 });
    }

    // «На адрес»: ящик закреплён за адресом навсегда, перенос — осознанное
    // действие оператора (адрес умер или выгорел). updated_at не трогаем:
    // монитор считает по нему «упавшие за час» ящики.
    if (action === 'move') {
      const egressIp = body.egressIp;
      if (!isIpv4(egressIp)) return jsonError('Неизвестный адрес', 400);
      const { data: target } = await supabaseAdmin
        .from('sender_egress_ips').select('ip').eq('ip', egressIp).maybeSingle();
      if (!target) return jsonError('Адрес не найден', 404);
      const { error, count } = await supabaseAdmin
        .from('sender_mailboxes')
        .update({ egress_ip: egressIp }, { count: 'exact' })
        .in('id', ids);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true, affected: count ?? 0 });
    }

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
      const parsedFile = parseMailboxFile(file.name, Buffer.from(await file.arrayBuffer()));
      // Провайдер не спрашивается у человека: его определяет разбор — по
      // колонкам файла, шапке выгрузки и, если файл промолчал, по DNS домена.
      parsed = {
        fileRows: parsedFile.totalRows,
        truncated: parsedFile.totalRows > parsedFile.rows.length ? parsedFile.rows.length : null,
        result: await parseMailboxRows(parsedFile.rows),
      };
    } catch (e) {
      if (e instanceof FileParseError) return jsonError(e.message, 400);
      return jsonError(`Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
    }

    if (!parsed.result.mailboxes.length) {
      return NextResponse.json({ imported: 0, detected: {}, errors: parsed.result.errors }, { status: 200 });
    }

    const nowIso = new Date().toISOString();
    const rows = parsed.result.mailboxes.map((mailbox) => ({
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
    for (const mailbox of parsed.result.mailboxes) {
      detected[mailbox.provider] = (detected[mailbox.provider] ?? 0) + 1;
    }

    return NextResponse.json({
      imported: data?.length ?? 0,
      detected,
      errors: parsed.result.errors,
      fileRows: parsed.fileRows,
      truncated: parsed.truncated,
    });
  });
}
