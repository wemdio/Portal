import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isValidUuid } from '@/lib/apiValidation';
import {
  filterBlockedContacts,
  getBlockedContactSnapshot,
  type BlockedContactSnapshot,
} from '@/lib/clientBlocklist/blockedDomains';
import { logWarn } from '@/lib/loggerServer';
import { loadClientHeBase, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import {
  toClientEngBaseColumns,
  toClientEngBaseDataRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import {
  HE_LAUNCH_MAX_LEADS,
  findCompanyKeyColumns,
  findEmailColumn,
  heConstructContactCap,
  heLaunchEmailVerdict,
  mapBaseRowsToLeads,
  selectLeadsWithinLaunchCap,
} from '@/lib/hypothesisEngine/launchHandoff';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import { selectHeEngEmailRows } from '@/lib/hypothesisEngine/engEmailPolicy';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

/** Дефолт/потолок страницы превью базы (data jsonb читается целиком, режем в памяти). */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === null || !Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  // Ниже минимума — мусорный ввод → дефолт; выше максимума — тихий кламп.
  if (v < min) return fallback;
  return Math.min(max, v);
}

/**
 * «Ready to send: X of Y checked» — сколько адресов базы запуск отправил бы
 * СЕЙЧАС и почему остальные проверенные не уйдут. Каждое число своим именем,
 * и они складываются: checked = to_send + flagged + failed + unusable +
 * repeated + blocked + over_limit.
 */
interface EngReadyToSend {
  /** Адресов, которые запуск отправил бы сейчас. */
  to_send: number;
  /** Строк с адресом и вердиктом проверки почты (принят или отклонён). */
  checked: number;
  /** Помечены «не подходит рынку» (`_low_relevance`, только авто-база). */
  flagged: number;
  /** Не прошли проверку почты. */
  failed: number;
  /** Прошли проверку, но в ячейке не один годный адрес. */
  unusable: number;
  /** Повтор адреса, который уже посчитан. */
  repeated: number;
  /** В «Do not contact» клиента: адрес или домен компании (адреса или сайта). */
  blocked: number;
  /** Сверх потолка одного запуска (`limit`). */
  over_limit: number;
  limit: number;
}

/**
 * Счёт запуска us-проекта по строкам базы — ТЕ ЖЕ функции и ТОТ ЖЕ порядок,
 * что у ядра (launchTemplate.runHeTemplateLaunch, шаги 5 → 5a → 5b), без
 * единого вызова рассыльщика:
 *  1. строки с адресом и вердиктом — «проверенные»; у авто-базы сначала
 *     снимаются помеченные `_low_relevance`, затем отклонённый вердикт
 *     (heLaunchEmailVerdict). Строки без вердикта ядро us тоже снимает, но в
 *     «проверенные» они не входят;
 *  2. mapBaseRowsToLeads с колонкой адреса ядра (findEmailColumn по всем
 *     строкам): не один адрес в ячейке — `unusable`, повтор — `repeated`;
 *  3. чёрный список клиента (getBlockedContactSnapshot + filterBlockedContacts:
 *     адреса и домены, сайт строки — колонкой findCompanyKeyColumns, как у
 *     ядра) — `blocked`, снимок передаёт вызывающий;
 *  4. потолок запуска (selectLeadsWithinLaunchCap, HE_LAUNCH_MAX_LEADS) —
 *     `over_limit`.
 * Отказы ядра, которые снимают запуск целиком (база собрана до разноса
 * адресов по строкам, письма с подстановкой без колонки, бренд), здесь не
 * считаются: про первый экран говорит сам (SendVolume), про письма —
 * карточка рынка. Запуск при старте считает заново по свежим строкам и
 * списку.
 */
function countReadyToSend(input: {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  isAutoBase: boolean;
  blocked: BlockedContactSnapshot;
}): EngReadyToSend {
  const { rows, columns, isAutoBase } = input;
  const emailColumn = findEmailColumn(columns, rows);
  let checked = 0;
  let flagged = 0;
  let failed = 0;
  const passed: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (!emailColumn || String(row[emailColumn] ?? '').trim() === '') continue;
    const verdict = heLaunchEmailVerdict(row._email_status, { allowCatchAll: true });
    if (verdict === 'missing') continue;
    checked += 1;
    if (isAutoBase && row._low_relevance === true) {
      flagged += 1;
    } else if (verdict === 'rejected') {
      failed += 1;
    } else {
      passed.push(row);
    }
  }
  const ordered = selectHeEngEmailRows(passed);
  const mapped = mapBaseRowsToLeads({ rows: ordered, columns, emailColumn });
  const unusable = mapped.multiAddressRows + mapped.malformedEmailRows;
  const repeated = passed.length - unusable - mapped.leads.length;
  const websiteColumn = findCompanyKeyColumns(columns).website;
  const filtered = filterBlockedContacts(mapped.leads, input.blocked, (_lead, i) =>
    websiteColumn ? ordered[mapped.leadRowIndices[i]]?.[websiteColumn] : null,
  );
  // `kept` — те же объекты лидов: строки восстанавливаются по ссылке.
  const allowed = new Set<object>(filtered.kept);
  const keptRowIndices = mapped.leadRowIndices.filter((_, i) => allowed.has(mapped.leads[i]));
  const toSend =
    filtered.kept.length > HE_LAUNCH_MAX_LEADS
      ? selectLeadsWithinLaunchCap({ rows: ordered, columns, leadRowIndices: keptRowIndices, limit: HE_LAUNCH_MAX_LEADS, allowCatchAll: true })
          .keptLeadPositions.length
      : filtered.kept.length;
  return {
    to_send: toSend,
    checked,
    flagged,
    failed,
    unusable,
    repeated,
    blocked: filtered.blockedCount,
    over_limit: filtered.kept.length - toSend,
    limit: HE_LAUNCH_MAX_LEADS,
  };
}

// GET — страница строк СВОЕЙ базы для превью (карточка рынка шага 3 «Launch»).
// Только чтение he_bases: data — массив Record по именам columns (вердикт
// валидации почты живёт на строке как _email_status, в columns не входит).
// offset (default 0) / limit (default 100, max 500) — серверный slice.
//
// ?ready=1 — ещё и `ready` (countReadyToSend): счёт запуска по ВСЕМ строкам
// базы плюс одно чтение чёрного списка клиента. Только у проекта market='us' —
// счёт повторяет правило us-запуска. `ready: null` — посчитать честно нельзя:
// база собрана до разноса адресов по строкам (запуск откажет ей целиком),
// чёрный список не прочитался или рынок не us. Без параметра ответ прежний.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!isValidUuid(id)) return jsonError('Invalid id', 400);

  const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  // Скоуп владельца до чтения data: чужая база — 404, существование не раскрываем.
  const owned = await loadClientHeBase(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const url = new URL(req.url);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const wantReady = url.searchParams.get('ready') === '1';

  // source и collect_info->construct читает только счёт `ready` — два лёгких
  // поля рядом с `data`.
  const { data: base, error } = await supabaseAdmin
    .from('he_bases')
    .select('id, status, row_count, columns, data, source, ci_construct:collect_info->construct')
    .eq('id', id)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return jsonError('Base not found', 404);
    return engServerError('client.eng.bases.rows_failed', error, 'Failed to load the base rows', {
      userId: result.auth.userId,
      baseId: id,
    });
  }

  const rows = Array.isArray((base as { data?: unknown }).data)
    ? ((base as { data: unknown[] }).data as Array<Record<string, unknown>>)
    : [];
  const columns = Array.isArray((base as { columns?: unknown }).columns)
    ? ((base as { columns: unknown[] }).columns as string[])
    : [];

  let ready: EngReadyToSend | null = null;
  if (wantReady && projectMarket(owned.project as { market?: string | null }) === 'us') {
    const construct = (base as { ci_construct?: unknown }).ci_construct;
    // Шаг 4c ядра: us-база без отметки построчных вердиктов, у которой вердикты
    // есть, — запуск откажет ей целиком; числа «к отправке» у неё нет.
    const legacy =
      heConstructContactCap({ construct }) === null &&
      rows.some((r) => heLaunchEmailVerdict(r._email_status) !== 'missing');
    if (!legacy && supabaseInstantly) {
      try {
        const blocked = await getBlockedContactSnapshot(supabaseInstantly, result.auth.userId);
        ready = countReadyToSend({
          rows,
          columns,
          isAutoBase: (base as { source?: unknown }).source === 'auto',
          blocked,
        });
      } catch (e) {
        // Не знаем список — не печатаем число, которое он мог бы уменьшить.
        void logWarn('client.eng.bases.ready_blocklist_unread', e instanceof Error ? e.message : 'unknown', {
          userId: result.auth.userId,
          baseId: id,
        });
      }
    }
  }

  // Строки базы принадлежат клиенту, но в них есть и наше: провенанс источника
  // (`source_detail` — код поставщика, русские подписи, поисковый запрос плана)
  // и служебные пометки `_*`. Они остаются на сервере, включая статусы почт.
  // Проецируем только отданную страницу: сама `data` — до 50k строк.
  // Existing bases can still contain diagnostic/rejected rows. Only checked
  // deliverable contacts belong in the client preview, before pagination.
  const clientRows = selectHeEngEmailRows(rows);
  return NextResponse.json({
    columns: toClientEngBaseColumns(columns),
    rows: clientRows.slice(offset, offset + limit).map(toClientEngBaseDataRow),
    total: clientRows.length,
    status: (base as { status?: string }).status,
    row_count: clientRows.length,
    ...(wantReady ? { ready } : {}),
  });
}
