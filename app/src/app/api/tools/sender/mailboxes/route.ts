import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { parseMailboxFile, FileParseError } from '@/lib/sender/fileParse';
import { parseMailboxRows } from '@/lib/sender/mailboxImport';
import { HEALTH_WINDOW_DAYS, mailboxHealth } from '@/lib/sender/mailboxHealth';
import { isIpv4 } from '@/lib/sender/egress';
import { addTagMailboxesToLiveCampaigns } from '@/lib/sender/campaignTags';
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

const BULK_ACTIONS = ['recheck', 'enable', 'disable', 'delete', 'tag', 'move', 'limits'] as const;
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

    // Сортировка по умолчанию — по email: батч-импорт даёт всем строкам одинаковое
    // created_at, и сортировка по нему дёргает список при каждом опросе
    // статусов — строки менялись местами каждые пару секунд.
    // Сортировка по столбцу (?sort=…&dir=asc|desc, 15.10.2026) идёт по всему
    // списку, а не по странице: порядок считает база. «Здоровье» в базе не
    // лежит, поэтому по нему считаем оценку у всех подходящих ящиков и режем
    // страницу уже после сортировки.
    const SORT_COLUMNS: Record<string, string> = {
      email: 'email',
      provider: 'provider',
      egress: 'egress_ip',
      status: 'status',
      new: 'daily_campaign_limit',
      total: 'daily_total_limit',
    };
    const sortKey = url.searchParams.get('sort') ?? '';
    const sortAsc = url.searchParams.get('dir') !== 'desc';

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
    // Фильтр по адресу отправки: 'none' — ящики, которым адрес ещё не выдан.
    const egressFilter = url.searchParams.get('egressIp') ?? '';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (q: any) => {
      if (search) q = q.ilike('email', `%${search}%`);
      if (tagIds.length && noTag) q = q.or(`tag_id.in.(${tagIds.join(',')}),tag_id.is.null`);
      else if (tagIds.length) q = q.in('tag_id', tagIds);
      else if (noTag) q = q.is('tag_id', null);
      if (egressFilter === 'none') q = q.is('egress_ip', null);
      else if (isIpv4(egressFilter)) q = q.eq('egress_ip', egressFilter);
      return q;
    };

    let data: Record<string, unknown>[] | null = null;
    let count: number | null = null;
    let error: { message: string } | null = null;

    if (sortKey === 'health') {
      const all: { id: string; status: string; email: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const r = await applyFilters(
          supabaseAdmin.from('sender_mailboxes').select('id, status, email').order('email', { ascending: true }),
        ).range(from, from + 999);
        if (r.error) return jsonError(r.error.message, 500);
        all.push(...((r.data ?? []) as typeof all));
        if ((r.data?.length ?? 0) < 1000) break;
      }
      const score = new Map<string, number | null>();
      for (let i = 0; i < all.length; i += 500) {
        const chunk = all.slice(i, i + 500);
        const { data: healthRows } = await supabaseAdmin.rpc('sender_mailbox_health', {
          p_ids: chunk.map((m) => m.id),
          p_days: HEALTH_WINDOW_DAYS,
        });
        const byId = new Map(
          ((healthRows ?? []) as { mailbox_id: string; sent: number | string; bounced: number | string; failed: number | string }[]).map(
            (row) => [row.mailbox_id, row],
          ),
        );
        for (const m of chunk) {
          const c = byId.get(m.id);
          score.set(m.id, c ? mailboxHealth({ sent: Number(c.sent), bounced: Number(c.bounced), failed: Number(c.failed), status: m.status }).score : null);
        }
      }
      // Ящики без оценки (мало писем) — всегда в конце, в любом направлении.
      all.sort((a, b) => {
        const sa = score.get(a.id) ?? null;
        const sb = score.get(b.id) ?? null;
        if (sa === null && sb === null) return a.email.localeCompare(b.email);
        if (sa === null) return 1;
        if (sb === null) return -1;
        return (sortAsc ? sa - sb : sb - sa) || a.email.localeCompare(b.email);
      });
      const pageIds = all.slice((page - 1) * pageSize, page * pageSize).map((m) => m.id);
      count = all.length;
      if (pageIds.length) {
        const r = await supabaseAdmin.from('sender_mailboxes').select(LIST_COLS).in('id', pageIds);
        error = r.error;
        const order = new Map(pageIds.map((id, i) => [id, i]));
        data = ((r.data ?? []) as unknown as Record<string, unknown>[]).sort(
          (a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
        );
      } else {
        data = [];
      }
    } else {
      const column = SORT_COLUMNS[sortKey] ?? 'email';
      let query = applyFilters(supabaseAdmin.from('sender_mailboxes').select(LIST_COLS, { count: 'exact' }));
      query = query.order(column, { ascending: sortAsc, nullsFirst: false });
      if (column !== 'email') query = query.order('email', { ascending: true });
      const r = await query.range((page - 1) * pageSize, page * pageSize - 1);
      data = r.data as Record<string, unknown>[] | null;
      count = r.count;
      error = r.error;
    }

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

    // Здоровье ящиков страницы: отправлено / отбои / ошибки за 14 дней. Сбой
    // расчёта не роняет список — просто без оценки.
    const healthByMailbox = new Map<string, { sent: number; bounced: number; failed: number }>();
    if (pageIds.length) {
      const { data: healthRows, error: healthError } = await supabaseAdmin.rpc('sender_mailbox_health', {
        p_ids: pageIds,
        p_days: HEALTH_WINDOW_DAYS,
      });
      if (!healthError) {
        for (const row of (healthRows ?? []) as { mailbox_id: string; sent: number | string; bounced: number | string; failed: number | string }[]) {
          healthByMailbox.set(row.mailbox_id, { sent: Number(row.sent), bounced: Number(row.bounced), failed: Number(row.failed) });
        }
      }
    }

    // Сколько ушло сегодня (день по UTC — так же считает планировщик): всего и
    // первых писем. Сбой чтения не роняет список — просто без счётчика.
    const sentToday = new Map<string, { total: number; first: number }>();
    if (pageIds.length) {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      for (let from = 0; ; from += 1000) {
        const { data: rows, error: sentError } = await supabaseAdmin
          .from('sender_messages')
          .select('mailbox_id, step_no')
          .in('mailbox_id', pageIds)
          .eq('status', 'sent')
          .gte('sent_at', dayStart.toISOString())
          .order('id')
          .range(from, from + 999);
        if (sentError) break;
        for (const row of (rows ?? []) as { mailbox_id: string; step_no: number }[]) {
          const acc = sentToday.get(row.mailbox_id) ?? { total: 0, first: 0 };
          acc.total += 1;
          if (row.step_no === 1) acc.first += 1;
          sentToday.set(row.mailbox_id, acc);
        }
        if ((rows?.length ?? 0) < 1000) break;
      }
    }

    return NextResponse.json({
      mailboxes: mailboxes.map((mailbox) => {
        const id = String((mailbox as { id?: string }).id);
        const counts = healthByMailbox.get(id);
        return {
          ...mailbox,
          sent_today: sentToday.get(id) ?? { total: 0, first: 0 },
          probe: probeByMailbox.get(id) ?? null,
          health: counts
            ? mailboxHealth({ ...counts, status: String((mailbox as { status?: string }).status ?? '') })
            : null,
        };
      }),
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
      | { ids?: unknown; action?: unknown; tagId?: unknown; egressIp?: unknown; dailyCampaignLimit?: unknown; dailyTotalLimit?: unknown }
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
      // Ящики попали под тег — идущие кампании, привязанные к тегу целиком, берут их сами.
      let campaignsUpdated = 0;
      if (tagId) {
        try {
          campaignsUpdated = await addTagMailboxesToLiveCampaigns(tagId, ids);
        } catch (e) {
          console.warn('[sender] tag mailboxes to live campaigns failed:', e);
        }
      }
      return NextResponse.json({ ok: true, affected: count ?? 0, campaignsUpdated });
    }

    // «Лимиты»: «новых в день» и «всего в день» на всю выборку (15.10.2026).
    // Можно задать оба или только один; пределы те же, что у одиночной правки ящика.
    if (action === 'limits') {
      const patch: Record<string, unknown> = {};
      const clamp = (v: unknown) => Math.max(1, Math.min(500, Math.floor(Number(v))));
      if (typeof body.dailyCampaignLimit === 'number' && Number.isFinite(body.dailyCampaignLimit)) patch.daily_campaign_limit = clamp(body.dailyCampaignLimit);
      if (typeof body.dailyTotalLimit === 'number' && Number.isFinite(body.dailyTotalLimit)) patch.daily_total_limit = clamp(body.dailyTotalLimit);
      if (!Object.keys(patch).length) return jsonError('Укажите «новых» или «всего» в день', 400);
      patch.updated_at = nowIso;
      const { error, count } = await supabaseAdmin
        .from('sender_mailboxes')
        .update(patch, { count: 'exact' })
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
