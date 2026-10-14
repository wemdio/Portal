/**
 * ENG «Do not contact»: человек, которого клиент добавил в свой список,
 * снимается и с его УЖЕ ИДУЩИХ кампаний (решение владельца 14.10.2026). Сам
 * список (client_blocked_contacts, БД рассыльщика) только отсекает новые
 * загрузки: запуск, «Launch N more markets», ночной долив.
 *
 * ВЫКЛЮЧАТЕЛЬ HE_ENG_DNC_REMOVE — по умолчанию ВЫКЛЮЧЕН (включают '1', 'true',
 * 'on', 'yes'). Выключен: роут не пишет заявок, воркер не разбирает очередь,
 * сводка страницы не читается, удаление адреса из списка таблиц не трогает —
 * ни одного запроса в таблицы he_eng_dnc_intents / he_eng_dnc_removals и ни
 * одного вызова рассыльщика. Переменную читают порознь роут (процесс portal) и
 * воркер hypothesis-engine. Миграция 20261014_0005 — до включения.
 *
 * ПУТЬ АДРЕСА.
 *  1. Роут POST /api/client/blocklist (ENG-ветка, _eng.ts) ДО вставки в список
 *     пишет заявку he_eng_dnc_intents с адресами запроса (openHeEngDncIntent);
 *     её created_at — момент просьбы по часам приложения (`since`). Заявка не
 *     записалась — добавление всё равно идёт, а ответ несёт
 *     `removal: 'not_scheduled'`: кампании не проверяются, пока клиент не
 *     добавит эти адреса ещё раз (повтор — новая заявка).
 *  2. После вставки (settleHeEngDncIntent): ничего не добавлено — заявка
 *     удаляется; добавлено или исход неизвестен — заявка разворачивается сразу
 *     и удаляется. Не развернулась (кампании клиента не прочитались, процесс
 *     умер) — заявка остаётся: next_at у неё на FAST_PATH_GRACE_MS вперёд, и
 *     после этого её разворачивает воркер. Это и есть прочная отметка «надо
 *     разложить по кампаниям». Что сказать клиенту, решает исход разворота
 *     (heEngDncRemovalView): кампаний нет — 'none_running'; есть — 'removing'
 *     с их числом; не развернулась — 'deferred'.
 *  3. Разворот (expandHeEngDncEmails): адреса заявки, которые СЕЙЧАС стоят в
 *     списке клиента, × его кампании (readHeEngDncCampaigns) →
 *     he_eng_dnc_enqueue(…, since). Каждое добавление — просьба проверить ВСЕ
 *     кампании заново: строки, проверенные ДО просьбы (done, not_found,
 *     cancelled, failed), возвращаются в очередь; проверенные после просьбы и
 *     ждущие — не трогаются (повтор разворота той же заявки ничего не делает).
 *     Разложенные адреса вычёркиваются из заявок 'failed' клиента.
 *  3a. ЗАПУСК В ПОЛЁТЕ. Запуск читает список один раз, в начале
 *     (launchTemplate, шаг 5a), а кампании создаёт и грузит в них людей через
 *     минуты: адрес, добавленный в это время, запуск ещё может загрузить — в
 *     кампанию, которой при развороте ещё нет в записях, или в записанную, но
 *     после того, как воркер её уже проверил. Поэтому разворот смотрит, идёт ли
 *     у клиента запуск: строка he_eng_auto_launch 'running' с живой арендой
 *     (её берут и кнопка «Launch now», и автозапуск — на ВЕСЬ запуск, с
 *     первого шага, продлевая каждые 2 мин) или launch_info.running_until в
 *     будущем (аренда записи у ядра, в том числе у запуска из инструмента
 *     команды). Идёт — заявка не удаляется, а становится 'after_launch':
 *     воркер раз в HE_ENG_DNC_WATCH_POLL_MS смотрит, кончился ли запуск, и
 *     тогда раскладывает её ЗАНОВО с since = момент этого разворота — все
 *     кампании, включая новые и проверенные во время запуска, проверяются
 *     ещё раз. Запуск не кончился за HE_ENG_DNC_WATCH_MAX_MS — заявка
 *     'failed' (launch_still_running) и алерт команде. Чего это не ловит:
 *     ночной долив читает список прямо перед загрузкой (секунды) и аренды не
 *     держит — адрес, добавленный в эти секунды, может проскочить.
 *  3b. BLOCK НА REPLIES: заявка на один адрес с id ответа (`replyId`). Роут
 *     читает событие ответа (instantly_activity_events, 'replied'); адрес
 *     события совпал с блокируемым — его кампания пишется в заявку
 *     (skip_campaign_id) и при развороте, если она есть в записях клиента, не
 *     проверяется: она перестала писать человеку, когда он ответил (каждая
 *     кампания кабинета — stop on reply), а удаление ответившего лида могло
 *     бы изменить счётчики ответов этой кампании (не проверено на живом
 *     рассыльщике). Её ждущие и неудавшиеся строки этого адреса закрываются
 *     ('cancelled', 'replied'). Чужой id ничего не даёт: кампания чужого
 *     события не в записях клиента, и пропускать нечего.
 *  4. Воркер (createHeEngDncRemovalTicker — между джобами hypothesis-engine,
 *     runHeEngDncRemovalPass): заявки, которым пора ('pending' и
 *     'after_launch'), — разворот; затем до HE_ENG_DNC_ROWS_PER_PASS строк
 *     очереди (he_eng_dnc_claim, по кругу клиентов) — снять лида.
 *  5. Клиент убрал адрес из списка (DELETE /api/client/blocklist/[id] →
 *     releaseHeEngDncAddress): его строки 'queued' и 'failed' становятся
 *     'cancelled' (last_error 'unlisted'). Уже снятых обратно не добавляем.
 *
 * ЧТО ВИДИТ КЛИЕНТ (readHeEngDncSummary). `pending` — разных адресов ждут
 * проверки (строки 'queued' и заявки 'pending' и 'after_launch'). `failed` — только то, с чем
 * клиент ещё может что-то сделать: адрес ВСЁ ЕЩЁ в списке, а кампания строки
 * всё ещё в его записях, не завершена (3) и не пропала у рассыльщика
 * (he_eng_campaign_status.read_error 'not_found'); адрес заявки 'failed' —
 * если такая кампания у клиента есть хоть одна. Так «не удалось» гаснет само:
 * адрес убран из списка, добавлен заново (строки снова в очереди, заявка
 * вычеркнута) или кампании больше нет. Сотрудник, снявший человека руками,
 * закрывает строку SQL из алерта (engSendingAlert, 'dnc_removal_failed').
 *
 * ЧЬЯ КАМПАНИЯ — fail-closed. Только из записей о запуске самого клиента:
 * he_projects (created_by = клиент, market 'us') → he_verticals →
 * he_templates.launch_info, и только запуски, чей пресет — пресет этого же
 * клиента (client_campaign_presets.client_user_id; то же правило, что у старта
 * кампаний, engCampaignSending.launchWorkspace). Записи читаются заново на
 * каждом проходе; не прочитались (или не прочитался список клиента) —
 * рассыльщика по строкам этого клиента в проходе не зовём, а строке, как при
 * любом сбое, — пауза, и попытка потрачена. Строка, чьей кампании в записях
 * клиента нет, становится 'failed' без единого вызова рассыльщика. Блоклист
 * воркспейса рассыльщика (общий для всех клиентов воркспейса) не трогается
 * никогда; RU-кампании в записи ENG не попадают.
 *
 * ВОРКСПЕЙС кампании: he_eng_campaign_status.instantly_account_id — тот, в
 * котором рассыльщик её вернул при удачном чтении («проверенный»: только там
 * «404» значит «кампании нет»); иначе воркспейс пресета записи о запуске
 * (кампания создана в нём, launchTemplate.ts) — там «404» не вывод, а сбой.
 *
 * СНЯТЬ ЛИДА (одна строка, removeOne): GET /campaigns/{id} в этом воркспейсе
 * (раз в VERIFIED_CAMPAIGN_TTL_MS на кампанию в процессе) → POST /leads/list
 * {campaign, contacts: [адрес]} — то же чтение, что у сверки доставки VE2:
 * каждая вернувшаяся запись обязана быть из ЭТОЙ кампании (иначе фильтр
 * проигнорирован — вывода нет), совпадение — точный нормализованный адрес,
 * «нет» — только по дочитанному ответу; больше MAX_MATCHES записей — сбой без
 * удаления → DELETE /leads/{id} (deleteLead; не проверен на живом рассыльщике
 * — см. отчёт .r12-reports/build-dnc.md) → ПРОВЕРОЧНЫЙ поиск той же кампании
 * (одна страница): 'done' пишется, только когда адреса там больше нет. Ответ
 * 2xx без подтверждения, «404» на удаление (так же отвечает и неверный путь),
 * обрыв или срок — НЕ «снято»: строка ждёт следующей попытки, а id, которому
 * ушло удаление, остаётся в lead_ids; следующая попытка, не найдя адреса,
 * пишет 'done' с этим id.
 *
 * ОГРАНИЧИТЕЛЬ. Все вызовы — через общий транспорт lib/instantly (общий
 * ограничитель воркспейса, как у всех вызовов, кроме LIST /emails; полос
 * чтения /emails эти вызовы не касаются — /emails здесь не зовётся), без
 * повторов на 429 внутри процесса и со своим сроком; метка расхода
 * HE_ENG_DNC_CONSUMER. Проход делает не больше HE_ENG_DNC_CALLS_PER_PASS (5)
 * вызовов — это жёсткий потолок: строка начинается, только если на неё
 * хватает худшего случая до удаления включительно (проверка кампании 1 +
 * поиск MAX_LOOKUP_PAGES + удаление MAX_MATCHES = 4), а проверочный поиск
 * (CONFIRM_LOOKUP_PAGES) делается, только если на него остался вызов; не
 * остался — строка возвращается в очередь без траты попытки, с id удалённой
 * записи, и её следующий поиск и есть проверка. Обычно 2 строки за проход
 * (строка, которой нет в кампании, — 1 вызов, найденная — 3). 429, 5xx,
 * 401/403, обрыв или срок — строке пауза, и проход кончается (остальные
 * строки возвращаются в очередь без траты попытки).
 *
 * ПОВТОРЫ. Попытка тратится, когда строку берут (he_eng_dnc_claim, сразу +1):
 * процесс, умерший посреди прохода, оставляет строку с арендой
 * HE_ENG_DNC_LEASE_MS — после неё её берут снова. Неудача — next_at через
 * 1, 2, 4… мин (не больше часа); HE_ENG_DNC_MAX_ATTEMPTS попыток — 'failed' и
 * алерт команде 'dnc_removal_failed' (engSendingAlert: раз в час на клиента).
 * Повторный вызов на уже снятую запись даёт «нет в кампании» — повтор
 * безопасен. Заявки — так же (свои попытки и аренда).
 *
 * Модуль НЕ БРОСАЕТ наружу: каждая экспортируемая функция отвечает значением.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidUuid } from '@/lib/apiValidation';
import { normalizeBlockedEmail } from '@/lib/clientBlocklist/blockedContacts';
import { deleteLead, getCampaign, listLeads } from '@/lib/instantly/client';
import { InstantlyApiError } from '@/lib/instantly/errors';
import { resolveInstantlyAccountId, type InstantlyRequestOptions } from '@/lib/instantly/accounts';
import { CampaignStatus } from '@/lib/instantly/types';
import { logWarn } from '@/lib/loggerServer';
import { parseLaunchInfo, readHeLaunchLease } from './launchHandoff';
import { heEngLaunchCampaigns, heEngWorkspaceConfigured, readHeEngCampaignStatusRows } from './engCampaignStatus';
import { notifyHeEngSending } from './engSendingAlert';

/* ─────────────── Выключатель и константы ─────────────── */

export const HE_ENG_DNC_REMOVE_ENV = 'HE_ENG_DNC_REMOVE';
const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);

/** Включено ли снятие с идущих кампаний. Нет переменной или иное значение — выключено. */
export function heEngDncRemovalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ON_VALUES.has((env[HE_ENG_DNC_REMOVE_ENV] ?? '').trim().toLowerCase());
}

export const HE_ENG_DNC_INTENTS_TABLE = 'he_eng_dnc_intents';
export const HE_ENG_DNC_REMOVALS_TABLE = 'he_eng_dnc_removals';
/** Метка счётчика использования рассыльщика (instantly_api_usage_hourly). */
export const HE_ENG_DNC_CONSUMER = 'he_eng_dnc_remove';

/** Проход воркера — не чаще. */
export const HE_ENG_DNC_TICK_MS = 60_000;
/** Сколько проход держит очередь джоб воркера; дальше он доходит фоном. */
export const HE_ENG_DNC_QUEUE_HOLD_MS = 15_000;
/**
 * После этого новые строки проход не начинает. Часы идут с конца чтения
 * записей о запуске и списков (не с начала прохода): медленная БД не должна
 * отпускать каждую взятую строку раньше, чем первая из них начнётся.
 */
const START_CUTOFF_MS = 10_000;
/** Строк очереди за проход (he_eng_dnc_claim). */
export const HE_ENG_DNC_ROWS_PER_PASS = 4;
/** Вызовов рассыльщика за проход — потолок, а не среднее (= худший случай одной строки). */
export const HE_ENG_DNC_CALLS_PER_PASS = 5;
/** Заявок за проход (разворот и проверка «запуск кончился» — только БД). */
export const HE_ENG_DNC_INTENTS_PER_PASS = 4;
/** Заявка 'after_launch': как часто воркер смотрит, кончился ли запуск клиента. */
export const HE_ENG_DNC_WATCH_POLL_MS = 2 * 60_000;
/**
 * Заявка 'after_launch' ждёт конца запуска не дольше — потом 'failed'
 * (launch_still_running) и алерт: живой запуск продлевает аренду, только пока
 * идёт, так что столько ждать — признак зависшего запуска, а не долгого.
 */
export const HE_ENG_DNC_WATCH_MAX_MS = 6 * 60 * 60_000;
/** Замок запуска шаблона ENG (engAutoLaunch.HE_ENG_AUTO_LAUNCH_TABLE; импорт тянул бы ядро запуска). */
const AUTO_LAUNCH_TABLE = 'he_eng_auto_launch';
/** События рассыльщика (engReplies.ts): ответ, на котором нажали Block. */
const ACTIVITY_TABLE = 'instantly_activity_events';
/** id события — bigint (тот же вид, что у курсора Replies). */
const REPLY_ID_RE = /^\d{1,15}$/;
/** Попыток строки или заявки до 'failed'. */
export const HE_ENG_DNC_MAX_ATTEMPTS = 10;
/** Аренда взятой строки или заявки: дольше худшего прохода, доходящего фоном. */
export const HE_ENG_DNC_LEASE_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
/** Сколько роут успевает развернуть свою заявку, прежде чем её возьмёт воркер. */
const FAST_PATH_GRACE_MS = 2 * 60_000;
const READ_TIMEOUT_MS = 10_000;
const DELETE_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
/** Страниц поиска лида по адресу в кампании: точный фильтр даёт одну. */
const MAX_LOOKUP_PAGES = 2;
/** Записей одного адреса в одной кампании, которые строка удаляет; больше — сбой без удаления. */
const MAX_MATCHES = 1;
/** Проверочный поиск после удаления — одна страница. */
const CONFIRM_LOOKUP_PAGES = 1;
/** Кампания, найденная в воркспейсе, перепроверяется не чаще (на процесс). */
const VERIFIED_CAMPAIGN_TTL_MS = 30 * 60_000;
/** Строк в одном чтении; столько и больше — полнота не доказана, отказ. */
const ROW_CAP = 1000;
const ID_CHUNK = 100;
/** Строк «адрес × кампания» в одном вызове he_eng_dnc_enqueue. */
const ENQUEUE_MAX_ROWS = 5000;
/** Адресов в одной заявке (столько же роут принимает за раз). */
const INTENT_MAX_EMAILS = 1000;
/** Примеров адресов «не удалось» в ответе страницы. */
const FAILED_EXAMPLES_MAX = 10;

/** Любая форма UUID (рассыльщик не обещает версию). */
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HeEngDncLog = (level: 'info' | 'warn' | 'error', msg: string) => void;

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message?: unknown }).message ?? '').slice(0, 200);
  return String(e).slice(0, 200);
}

function pgText(prefix: string, error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  return `${prefix}: ${code} ${errText(error)}`.trim();
}

function isMissing(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  return code === '42P01' || code === 'PGRST205' || code === '42883' || code === 'PGRST202';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Пауза после n-й неудачной попытки (n ≥ 1): 1, 2, 4… мин, не больше часа. */
export function heEngDncBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
}

function uniqueEmails(emails: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const email = normalizeBlockedEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Чтение `.in()` пачками; сбой любой пачки или пачка до потолка — null. */
async function readIn(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Array<Record<string, unknown>> | null> {
  const rows: Array<Record<string, unknown>> = [];
  for (const chunk of chunks(ids, ID_CHUNK)) {
    const { data, error } = await read(chunk);
    if (error || !Array.isArray(data) || data.length >= ROW_CAP) return null;
    rows.push(...(data as Array<Record<string, unknown>>));
  }
  return rows;
}

/* ─────────────── Кампании клиента ─────────────── */

export interface HeEngDncCampaign {
  campaignId: string;
  /** Воркспейс для вызовов; null — неизвестен или не настроен в окружении. */
  workspace: string | null;
  /** Рассыльщик вернул кампанию в этом воркспейсе при удачном чтении: «404» там — «кампании нет». */
  verified: boolean;
  /**
   * Кампания писем больше не шлёт и не начнёт (по кэшу he_eng_campaign_status):
   * завершена (статус 3) или пропала у рассыльщика (read_error 'not_found').
   * Только для сводки страницы: «не удалось снять» с такой кампании клиенту не
   * показывается. Воркер по этому признаку ничего не пропускает.
   */
  over: boolean;
}

/** Завершена или пропала у рассыльщика (по строке кэша статуса). */
function campaignOver(row: { status: number | null; read_error: 'not_found' | 'failed' | null } | undefined): boolean {
  return !!row && (row.status === CampaignStatus.Completed || row.read_error === 'not_found');
}

export type HeEngDncCampaignsRead =
  | {
      ok: true;
      campaigns: Map<string, HeEngDncCampaign>;
      foreignLaunches: number;
      /**
       * Только с `withLaunches`: у клиента идёт запуск (шапка, п. 3a) — до
       * какого момента (мс) он держит аренду; null — не идёт (или не спрашивали).
       */
      launchRunningUntilMs: number | null;
    }
  | { ok: false; detail: string };

/**
 * Кампании клиента из ЕГО записей о запуске (шапка, «Чья кампания»). Запуски с
 * чужим или нечитаемым пресетом не входят (`foreignLaunches`). Любой сбой
 * чтения проектов, вертикалей, шаблонов или пресетов — ok:false; строк кэша
 * статуса нет — воркспейсы только из пресетов (непроверенные).
 *
 * `withLaunches` (только разворот): ещё и идёт ли у клиента запуск — живая
 * аренда строки he_eng_auto_launch 'running' любого его us-проекта или
 * running_until записи о запуске любого его шаблона (шапка, п. 3a). Сбой
 * чтения замка — ok:false: «запуска нет» без чтения сказать нельзя.
 */
export async function readHeEngDncCampaigns(
  portalDb: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  userId: string,
  deps: { workspaceConfigured?: (accountId: string) => boolean; withLaunches?: boolean; now?: () => number } = {},
): Promise<HeEngDncCampaignsRead> {
  const configured = deps.workspaceConfigured ?? heEngWorkspaceConfigured;
  const fail = (detail: string): HeEngDncCampaignsRead => ({ ok: false, detail });
  const nowMs = (deps.now ?? Date.now)();
  const lease: { until: number | null } = { until: null };
  const noteLease = (ms: number | null) => {
    if (ms !== null && Number.isFinite(ms) && ms > nowMs && (lease.until === null || ms > lease.until)) lease.until = ms;
  };
  const empty = (): HeEngDncCampaignsRead => ({
    ok: true,
    campaigns: new Map(),
    foreignLaunches: 0,
    launchRunningUntilMs: lease.until,
  });
  try {
    const { data: projects, error: projErr } = await portalDb
      .from('he_projects')
      .select('id')
      .eq('created_by', userId)
      .eq('market', 'us')
      .limit(ROW_CAP);
    if (projErr || !Array.isArray(projects)) return fail(pgText('he_projects read', projErr));
    if (projects.length >= ROW_CAP) return fail(`he_projects: ${projects.length} rows hit the read cap`);
    const projectIds = (projects as Array<Record<string, unknown>>).map((p) => str(p.id)).filter(Boolean);
    if (projectIds.length === 0) return empty();

    if (deps.withLaunches) {
      // Замок запуска шаблона: кнопка и автозапуск держат его весь запуск, с
      // первого шага (до первой кампании у ядра своей аренды ещё нет).
      const running = await readIn(projectIds, (chunk) =>
        portalDb.from(AUTO_LAUNCH_TABLE).select('lease_until').in('project_id', chunk).eq('state', 'running').limit(ROW_CAP),
      );
      if (running === null) return fail(`${AUTO_LAUNCH_TABLE} read failed or hit the read cap`);
      for (const r of running) noteLease(typeof r.lease_until === 'string' ? Date.parse(r.lease_until) : null);
    }

    const verticals = await readIn(projectIds, (chunk) =>
      portalDb.from('he_verticals').select('id').in('project_id', chunk).limit(ROW_CAP),
    );
    if (verticals === null) return fail('he_verticals read failed or hit the read cap');
    const verticalIds = verticals.map((v) => str(v.id)).filter(Boolean);
    if (verticalIds.length === 0) return empty();

    const templates = await readIn(verticalIds, (chunk) =>
      portalDb
        .from('he_templates')
        .select('launch_info')
        .in('vertical_id', chunk)
        .not('launch_info', 'is', null)
        .limit(ROW_CAP),
    );
    if (templates === null) return fail('he_templates read failed or hit the read cap');
    // Аренда записи о запуске (ядро): достройка и force берут её с первого
    // шага, первый запуск — с первой кампании; запуск из инструмента команды
    // замка he_eng_auto_launch не берёт.
    if (deps.withLaunches) for (const t of templates) noteLease(readHeLaunchLease(t.launch_info).runningUntilMs);

    const launches = templates
      .map((t) => parseLaunchInfo(t.launch_info))
      .filter((l): l is NonNullable<typeof l> => l !== null);
    if (launches.length === 0) return empty();

    const presetIds = [...new Set(launches.map((l) => l.preset_id).filter((id) => id && isValidUuid(id)))];
    const presetWorkspace = new Map<string, string | null>();
    if (presetIds.length > 0) {
      if (!instantlyDb) return fail('instantly DB is not configured: launch presets unreadable');
      const presets = await readIn(presetIds, (chunk) =>
        instantlyDb
          .from('client_campaign_presets')
          .select('id, instantly_account_id')
          .in('id', chunk)
          .eq('client_user_id', userId)
          .limit(ROW_CAP),
      );
      if (presets === null) return fail('client_campaign_presets read failed');
      for (const p of presets) {
        const ws = resolveInstantlyAccountId(str(p.instantly_account_id) || null);
        presetWorkspace.set(str(p.id), configured(ws) ? ws : null);
      }
    }

    const own = launches.filter((l) => presetWorkspace.has(l.preset_id));
    const foreignLaunches = launches.length - own.length;
    const ownCampaigns = own.flatMap((l) =>
      heEngLaunchCampaigns(l).map((c) => ({ campaignId: c.campaignId, presetId: l.preset_id })),
    );
    const rows = await readHeEngCampaignStatusRows(
      portalDb,
      ownCampaigns.map((c) => c.campaignId),
    );

    const campaigns = new Map<string, HeEngDncCampaign>();
    for (const c of ownCampaigns) {
      if (campaigns.has(c.campaignId)) continue;
      const cached = rows?.get(c.campaignId);
      const recorded = cached?.instantly_account_id ?? null;
      const recordedWs = recorded ? resolveInstantlyAccountId(recorded) : null;
      const over = campaignOver(cached);
      if (recordedWs && configured(recordedWs)) {
        campaigns.set(c.campaignId, { campaignId: c.campaignId, workspace: recordedWs, verified: true, over });
      } else {
        campaigns.set(c.campaignId, {
          campaignId: c.campaignId,
          workspace: presetWorkspace.get(c.presetId) ?? null,
          verified: false,
          over,
        });
      }
    }
    return { ok: true, campaigns, foreignLaunches, launchRunningUntilMs: lease.until };
  } catch (e) {
    return fail(`campaigns read threw: ${errText(e)}`);
  }
}

/* ─────────────── Список клиента и разворот ─────────────── */

/** Какие из адресов стоят в списке клиента сейчас. null — не прочиталось. */
async function readListed(
  instantlyDb: SupabaseClient,
  userId: string,
  emails: readonly string[],
): Promise<Set<string> | null> {
  try {
    const rows = await readIn(emails, (chunk) =>
      instantlyDb
        .from('client_blocked_contacts')
        .select('email')
        .eq('client_user_id', userId)
        .in('email', chunk)
        .limit(ROW_CAP),
    );
    if (rows === null) return null;
    const out = new Set<string>();
    for (const r of rows) {
      const email = normalizeBlockedEmail(r.email);
      if (email) out.add(email);
    }
    return out;
  } catch {
    return null;
  }
}

export type HeEngDncExpandResult =
  | {
      ok: true;
      listed: number;
      /** Кампаний, по которым разложено (без кампании ответа `skip`). */
      campaigns: number;
      queued: number;
      foreignLaunches: number;
      /** У клиента идёт запуск (шапка, п. 3a): заявку надо разложить ещё раз, когда он кончится. */
      launchRunning: boolean;
      /** `holdWhileLaunchRunning` и запуск идёт: ничего не разложено. */
      held: boolean;
      /** Кампания ответа (Block) есть в записях клиента и не раскладывалась. */
      skippedReplyCampaign: boolean;
    }
  | { ok: false; code: 'list_unreadable' | 'campaigns_unreadable' | 'enqueue_failed'; detail: string };

export interface HeEngDncDeps {
  getCampaign?: typeof getCampaign;
  listLeads?: typeof listLeads;
  deleteLead?: typeof deleteLead;
  notify?: typeof notifyHeEngSending;
  workspaceConfigured?: (accountId: string) => boolean;
  now?: () => number;
}

/** Момент как timestamptz для he_eng_dnc_enqueue; битая строка — null. */
function sinceIso(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Разложить адреса клиента по его кампаниям (шапка, п. 3). Только адреса,
 * которые сейчас в его списке. `since` — момент просьбы клиента (created_at
 * заявки; у заявки 'after_launch' — момент этого разворота): строки,
 * проверенные до него, he_eng_dnc_enqueue возвращает в очередь, ждущие и
 * проверенные после — не трогает, так что повтор безопасен. Разложенные адреса
 * вычёркиваются из заявок 'failed' и при нуле кампаний.
 *
 * Заодно — идёт ли у клиента запуск (п. 3a, `launchRunning`). С
 * `holdWhileLaunchRunning` (заявка 'after_launch') при идущем запуске ничего
 * не раскладывается (`held`). `skipCampaignId` (Block, один адрес; п. 3b) —
 * кампания ответа: не раскладывается, если она есть в записях клиента.
 */
export async function expandHeEngDncEmails(input: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  userId: string;
  emails: readonly string[];
  since: string;
  skipCampaignId?: string | null;
  holdWhileLaunchRunning?: boolean;
  deps?: HeEngDncDeps;
}): Promise<HeEngDncExpandResult> {
  try {
    const emails = uniqueEmails(input.emails);
    const none = {
      ok: true as const,
      listed: 0,
      campaigns: 0,
      queued: 0,
      foreignLaunches: 0,
      launchRunning: false,
      held: false,
      skippedReplyCampaign: false,
    };
    if (emails.length === 0) return none;
    const since = sinceIso(input.since);
    if (!since) return { ok: false, code: 'enqueue_failed', detail: 'the moment of the request is unknown' };
    if (!input.instantlyDb) {
      return { ok: false, code: 'list_unreadable', detail: 'instantly DB is not configured' };
    }
    const listedSet = await readListed(input.instantlyDb, input.userId, emails);
    if (listedSet === null) return { ok: false, code: 'list_unreadable', detail: 'client_blocked_contacts read failed' };
    const listed = emails.filter((e) => listedSet.has(e));
    if (listed.length === 0) return none;

    const read = await readHeEngDncCampaigns(input.portalDb, input.instantlyDb, input.userId, {
      workspaceConfigured: input.deps?.workspaceConfigured,
      withLaunches: true,
      now: input.deps?.now,
    });
    if (!read.ok) return { ok: false, code: 'campaigns_unreadable', detail: read.detail };
    const launchRunning = read.launchRunningUntilMs !== null;
    if (launchRunning && input.holdWhileLaunchRunning) {
      return { ...none, listed: listed.length, campaigns: read.campaigns.size, foreignLaunches: read.foreignLaunches, launchRunning, held: true };
    }
    // Кампания ответа — только своя (из записей клиента) и только у заявки на один адрес.
    const skipRaw = (input.skipCampaignId ?? '').trim();
    const skip = skipRaw && listed.length === 1 && read.campaigns.has(skipRaw) ? skipRaw : null;
    const campaigns = [...read.campaigns.values()]
      .filter((c) => c.campaignId !== skip)
      .sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0))
      .map((c) => ({ campaign_id: c.campaignId, workspace: c.workspace }));
    if (campaigns.length > ENQUEUE_MAX_ROWS) {
      return { ok: false, code: 'enqueue_failed', detail: `${campaigns.length} campaigns exceed one enqueue call` };
    }
    // Ноль кампаний — тоже вызов: он вычёркивает адреса из заявок 'failed'
    // (и закрывает строки кампании ответа).
    const perCall = campaigns.length === 0 ? INTENT_MAX_EMAILS : Math.max(1, Math.floor(ENQUEUE_MAX_ROWS / campaigns.length));
    let queued = 0;
    for (const part of chunks(listed, perCall)) {
      const { data, error } = await input.portalDb.rpc('he_eng_dnc_enqueue', {
        p_user_id: input.userId,
        p_emails: part,
        p_campaigns: campaigns,
        p_since: since,
        p_skip_campaign: skip,
      });
      if (error) return { ok: false, code: 'enqueue_failed', detail: pgText('he_eng_dnc_enqueue', error) };
      queued += typeof data === 'number' && Number.isFinite(data) ? data : 0;
    }
    return {
      ok: true,
      listed: listed.length,
      campaigns: campaigns.length,
      queued,
      foreignLaunches: read.foreignLaunches,
      launchRunning,
      held: false,
      skippedReplyCampaign: skip !== null,
    };
  } catch (e) {
    return { ok: false, code: 'enqueue_failed', detail: `expand threw: ${errText(e)}` };
  }
}

/* ─────────────── Заявка роута ─────────────── */

export type HeEngDncIntent =
  | { kind: 'off' }
  /**
   * `since` — момент просьбы (created_at заявки), по часам приложения.
   * `skipCampaignId` — кампания ответа (Block на Replies, шапка п. 3b).
   */
  | { kind: 'open'; id: string; userId: string; emails: string[]; since: string; skipCampaignId: string | null }
  | { kind: 'unwritten' };

/**
 * Что сказать клиенту в ответе добавления (поле `removal`):
 *  - 'off' — снятие выключено;
 *  - 'none_running' — кампаний у клиента нет (у Block — кроме кампании
 *    ответа): снимать неоткуда, список проверяется перед каждой загрузкой;
 *  - 'removing' — адреса разложены по кампаниям клиента (их число — в
 *    `removal_campaigns`), воркер их проверяет и снимает найденных;
 *  к 'none_running' и 'removing' — `afterLaunch`: у клиента шёл запуск, и
 *  заявка разложится ещё раз, когда он кончится (шапка, п. 3a); и
 *  `skippedReplyCampaign`: кампания ответа (Block) не проверяется (п. 3b);
 *  - 'deferred' — заявка записана, но кампании сейчас не прочитались:
 *    разложит воркер (повторяет до HE_ENG_DNC_MAX_ATTEMPTS раз, потом
 *    «не удалось» на странице и алерт команде);
 *  - 'not_scheduled' — заявка не записалась: кампании не проверяются, пока
 *    клиент не добавит адреса ещё раз.
 */
export type HeEngDncRemovalView = 'off' | 'none_running' | 'removing' | 'deferred' | 'not_scheduled';

/**
 * Кампания ответа для Block (шапка, п. 3b): событие 'replied' с этим id, чей
 * адрес — ровно блокируемый. null — события нет или адрес другой (тогда
 * заявка — как у вставки: проверяются все кампании); 'unreadable' — не
 * прочиталось (заявка тогда не пишется: клиенту «Try again»).
 */
async function readReplyCampaign(
  db: SupabaseClient,
  replyId: string,
  email: string,
): Promise<string | null | 'unreadable'> {
  try {
    const { data, error } = await db
      .from(ACTIVITY_TABLE)
      .select('campaign_id, lead_email')
      .eq('id', replyId)
      .eq('event_type', 'replied')
      .limit(2);
    if (error || !Array.isArray(data)) return 'unreadable';
    if (data.length !== 1) return null;
    const row = data[0] as Record<string, unknown>;
    const campaignId = str(row.campaign_id).trim();
    return campaignId && normalizeBlockedEmail(row.lead_email) === email ? campaignId : null;
  } catch {
    return 'unreadable';
  }
}

/**
 * Заявка ДО вставки в список (шапка, п. 1). Выключено или адресов нет —
 * 'off' без запроса в БД. Не записалась — 'unwritten' (строка warn).
 * `replyId` — Block на Replies (один адрес; п. 3b): кампания ответа пишется в
 * заявку; событие не прочиталось — 'unwritten'.
 */
export async function openHeEngDncIntent(input: {
  portalDb: SupabaseClient | null;
  userId: string;
  emails: readonly string[];
  replyId?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<HeEngDncIntent> {
  if (!heEngDncRemovalEnabled(input.env)) return { kind: 'off' };
  const emails = uniqueEmails(input.emails);
  if (emails.length === 0) return { kind: 'off' };
  try {
    if (!input.portalDb || emails.length > INTENT_MAX_EMAILS) {
      void logWarn(
        'client.blocklist.eng_dnc_intent_failed',
        !input.portalDb ? 'основная БД не настроена — снятие с кампаний не заявлено' : `адресов ${emails.length} > ${INTENT_MAX_EMAILS}`,
        { count: emails.length },
        { userId: input.userId },
      );
      return { kind: 'unwritten' };
    }
    let skipCampaignId: string | null = null;
    const replyId = (input.replyId ?? '').trim();
    if (replyId && emails.length === 1 && REPLY_ID_RE.test(replyId)) {
      const replied = await readReplyCampaign(input.portalDb, replyId, emails[0]);
      if (replied === 'unreadable') {
        void logWarn(
          'client.blocklist.eng_dnc_intent_failed',
          'событие ответа (Block) не прочиталось — снятие с кампаний не заявлено',
          { count: 1 },
          { userId: input.userId },
        );
        return { kind: 'unwritten' };
      }
      skipCampaignId = replied;
    }
    const nowMs = (input.now ?? Date.now)();
    const since = new Date(nowMs).toISOString();
    const { data, error } = await input.portalDb
      .from(HE_ENG_DNC_INTENTS_TABLE)
      .insert({
        user_id: input.userId,
        emails,
        created_at: since,
        next_at: new Date(nowMs + FAST_PATH_GRACE_MS).toISOString(),
        ...(skipCampaignId ? { skip_campaign_id: skipCampaignId } : {}),
      })
      .select('id');
    const id = Array.isArray(data) ? str((data[0] as { id?: unknown } | undefined)?.id) : '';
    if (error || !id) {
      void logWarn(
        'client.blocklist.eng_dnc_intent_failed',
        `заявка на снятие с кампаний не записалась: ${pgText('he_eng_dnc_intents insert', error)}`,
        { count: emails.length },
        { userId: input.userId },
      );
      return { kind: 'unwritten' };
    }
    return { kind: 'open', id, userId: input.userId, emails, since, skipCampaignId };
  } catch (e) {
    void logWarn(
      'client.blocklist.eng_dnc_intent_failed',
      `заявка на снятие с кампаний бросила: ${errText(e)}`,
      { count: emails.length },
      { userId: input.userId },
    );
    return { kind: 'unwritten' };
  }
}

/**
 * Исход добавления для заявки: 'added' — адреса запроса стоят в списке (ответ
 * 2xx); 'nothing_added' — доказанно ничего не добавлено; 'unknown' — состав
 * списка после ответа неизвестен.
 */
export type HeEngDncAddOutcome = 'added' | 'nothing_added' | 'unknown';

/**
 * Исход заявки после вставки (шапка, п. 2): 'voided' — удалена, потому что
 * ничего не добавлено; 'expanded' — разложена по кампаниям (`campaigns` — их
 * число; сама заявка удалена или, если удаление не прошло, её повторный
 * разворот воркером ничего не изменит; `afterLaunch` — у клиента шёл запуск, и
 * заявка оставлена 'after_launch', п. 3a; `skippedReplyCampaign` — п. 3b);
 * 'deferred' — не разложена, её развернёт воркер (при 'nothing_added' он
 * развернёт только то, что окажется в списке).
 */
export type HeEngDncSettle =
  | { kind: 'none' }
  | { kind: 'voided' }
  | { kind: 'expanded'; campaigns: number; afterLaunch: boolean; skippedReplyCampaign: boolean }
  | { kind: 'deferred' };

/** Поля заявки, которая начинает ждать конца запуска (роут и воркер). */
function watchPatch(nowMs: number): Record<string, unknown> {
  const at = new Date(nowMs).toISOString();
  return {
    status: 'after_launch',
    attempts: 0,
    next_at: new Date(nowMs + HE_ENG_DNC_WATCH_POLL_MS).toISOString(),
    watch_from: at,
    last_error: null,
    updated_at: at,
  };
}

export async function settleHeEngDncIntent(
  intent: HeEngDncIntent,
  outcome: HeEngDncAddOutcome,
  input: { portalDb: SupabaseClient | null; instantlyDb: SupabaseClient | null; deps?: HeEngDncDeps },
): Promise<HeEngDncSettle> {
  if (intent.kind !== 'open') return { kind: 'none' };
  if (!input.portalDb) return { kind: 'deferred' };
  const db = input.portalDb;
  const clock = input.deps?.now ?? Date.now;
  const drop = async (): Promise<boolean> => {
    try {
      const { error } = await db.from(HE_ENG_DNC_INTENTS_TABLE).delete().eq('id', intent.id);
      return !error;
    } catch {
      return false;
    }
  };
  if (outcome === 'nothing_added') return (await drop()) ? { kind: 'voided' } : { kind: 'deferred' };
  const res = await expandHeEngDncEmails({
    portalDb: db,
    instantlyDb: input.instantlyDb,
    userId: intent.userId,
    emails: intent.emails,
    since: intent.since,
    skipCampaignId: intent.skipCampaignId,
    deps: input.deps,
  });
  if (!res.ok) {
    void logWarn(
      'client.blocklist.eng_dnc_expand_deferred',
      `снятие с кампаний разложит воркер: ${res.code} ${res.detail}`.slice(0, 300),
      { count: intent.emails.length },
      { userId: intent.userId },
    );
    return { kind: 'deferred' };
  }
  const done = { kind: 'expanded' as const, campaigns: res.campaigns, skippedReplyCampaign: res.skippedReplyCampaign };
  if (res.launchRunning) {
    // Запуск клиента идёт (п. 3a): заявка остаётся ждать его конца. Не
    // записалось — она 'pending' и через FAST_PATH_GRACE_MS её развернёт
    // воркер, увидит запуск и сам переведёт в 'after_launch'.
    let watched = false;
    try {
      const { data, error } = await db
        .from(HE_ENG_DNC_INTENTS_TABLE)
        .update(watchPatch(clock()))
        .eq('id', intent.id)
        .eq('status', 'pending')
        .select('id');
      watched = !error && Array.isArray(data) && data.length > 0;
    } catch {
      watched = false;
    }
    if (!watched) {
      void logWarn(
        'client.blocklist.eng_dnc_watch_left',
        'у клиента идёт запуск, а заявка не переведена в after_launch — это сделает воркер',
        { count: intent.emails.length },
        { userId: intent.userId },
      );
    }
    return { ...done, afterLaunch: true };
  }
  if (!(await drop())) {
    void logWarn(
      'client.blocklist.eng_dnc_intent_left',
      'заявка разложена, но не удалена — воркер развернёт её ещё раз (без изменений)',
      { count: intent.emails.length },
      { userId: intent.userId },
    );
  }
  return { ...done, afterLaunch: false };
}

/** Ответ добавления клиенту (поля `removal…` POST, шапка _eng.ts). */
export interface HeEngDncRemovalAnswer {
  removal: HeEngDncRemovalView;
  /** Число кампаний — только при 'removing'. */
  campaigns: number | null;
  /** 'removing' / 'none_running': у клиента шёл запуск — проверим ещё раз, когда он кончится. */
  afterLaunch: boolean;
  /** Block: кампания, на которую человек ответил, не проверяется (п. 3b). */
  skippedReplyCampaign: boolean;
}

export function heEngDncRemovalView(intent: HeEngDncIntent, settle: HeEngDncSettle): HeEngDncRemovalAnswer {
  const plain = { afterLaunch: false, skippedReplyCampaign: false };
  if (intent.kind === 'off') return { removal: 'off', campaigns: null, ...plain };
  if (intent.kind === 'unwritten') return { removal: 'not_scheduled', campaigns: null, ...plain };
  if (settle.kind === 'expanded') {
    const flags = { afterLaunch: settle.afterLaunch, skippedReplyCampaign: settle.skippedReplyCampaign };
    return settle.campaigns > 0
      ? { removal: 'removing', campaigns: settle.campaigns, ...flags }
      : { removal: 'none_running', campaigns: 0, ...flags };
  }
  return { removal: 'deferred', campaigns: null, ...plain };
}

/* ─────────────── Адрес убран из списка ─────────────── */

/**
 * Клиент убрал адрес из списка (шапка, п. 5): его строки 'queued' и 'failed'
 * — в 'cancelled' (last_error 'unlisted'). Выключено — без запроса. Сбой —
 * строка warn, и только: сводка страницы всё равно не считает адрес вне
 * списка, а воркер отменит его строку, когда до неё дойдёт. НЕ БРОСАЕТ.
 */
export async function releaseHeEngDncAddress(input: {
  portalDb: SupabaseClient | null;
  userId: string;
  email: unknown;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<void> {
  if (!heEngDncRemovalEnabled(input.env)) return;
  const email = normalizeBlockedEmail(input.email);
  if (!email || !input.portalDb) return;
  const at = new Date((input.now ?? Date.now)()).toISOString();
  try {
    const { error } = await input.portalDb
      .from(HE_ENG_DNC_REMOVALS_TABLE)
      .update({ status: 'cancelled', settled_at: at, last_error: 'unlisted', updated_at: at })
      .eq('user_id', input.userId)
      .eq('email', email)
      .in('status', ['queued', 'failed']);
    if (error && !isMissing(error)) {
      void logWarn('client.blocklist.eng_dnc_release_failed', pgText('he_eng_dnc_removals cancel', error), {}, { userId: input.userId });
    }
  } catch (e) {
    void logWarn('client.blocklist.eng_dnc_release_failed', `отмена строк бросила: ${errText(e)}`, {}, { userId: input.userId });
  }
}

/* ─────────────── Сводка для страницы ─────────────── */

export interface HeEngDncSummary {
  in_campaign_removal: 'off' | 'on';
  /** Разных адресов ждут проверки кампаний (строки 'queued', заявки 'pending' и 'after_launch'); null — выключено или не прочиталось. */
  pending: number | null;
  /**
   * Разных адресов, которые снять не удалось и с которыми клиент ещё может
   * что-то сделать (шапка, «Что видит клиент»); null — выключено или не
   * прочиталось.
   */
  failed: number | null;
  /** До FAILED_EXAMPLES_MAX таких адресов по алфавиту. */
  failed_examples: string[];
  /** Сводка отдала не все неудачи (их больше 1000 пар): `failed` — нижняя граница. */
  failed_at_least: boolean;
}

/**
 * Выключено — без запроса в БД. Неудачи сверяются со списком и записями
 * клиента (читаются, только когда неудачи есть); не прочиталось — failed null.
 * НЕ БРОСАЕТ.
 */
export async function readHeEngDncSummary(
  portalDb: SupabaseClient | null,
  instantlyDb: SupabaseClient | null,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: { workspaceConfigured?: (accountId: string) => boolean } = {},
): Promise<HeEngDncSummary> {
  const off: HeEngDncSummary = { in_campaign_removal: 'off', pending: null, failed: null, failed_examples: [], failed_at_least: false };
  if (!heEngDncRemovalEnabled(env)) return off;
  const unread: HeEngDncSummary = { ...off, in_campaign_removal: 'on' };
  if (!portalDb) return unread;
  try {
    const { data, error } = await portalDb.rpc('he_eng_dnc_summary', { p_user_id: userId });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) return unread;
    const raw = data as { pending?: unknown; failed?: unknown; failed_more?: unknown };
    const pending = typeof raw.pending === 'number' && Number.isSafeInteger(raw.pending) && raw.pending >= 0 ? raw.pending : null;
    if (!Array.isArray(raw.failed)) return { ...unread, pending };
    const entries: Array<{ email: string; campaignId: string | null }> = [];
    for (const f of raw.failed as Array<Record<string, unknown> | null>) {
      const email = normalizeBlockedEmail(f?.email);
      if (!email) continue;
      entries.push({ email, campaignId: str(f?.campaign_id) || null });
    }
    const atLeast = raw.failed_more === true;
    if (entries.length === 0) {
      return { ...unread, pending, failed: atLeast ? null : 0 };
    }
    if (!instantlyDb) return { ...unread, pending };
    const emails = [...new Set(entries.map((e) => e.email))];
    const listed = await readListed(instantlyDb, userId, emails);
    if (!listed) return { ...unread, pending };
    const read = await readHeEngDncCampaigns(portalDb, instantlyDb, userId, deps);
    if (!read.ok) return { ...unread, pending };
    const live = (id: string) => {
      const c = read.campaigns.get(id);
      return !!c && !c.over;
    };
    const anyLive = [...read.campaigns.values()].some((c) => !c.over);
    const actionable = new Set<string>();
    for (const e of entries) {
      if (!listed.has(e.email)) continue;
      if (e.campaignId ? live(e.campaignId) : anyLive) actionable.add(e.email);
    }
    const sorted = [...actionable].sort();
    return {
      in_campaign_removal: 'on',
      pending,
      failed: sorted.length,
      failed_examples: sorted.slice(0, FAILED_EXAMPLES_MAX),
      failed_at_least: atLeast,
    };
  } catch {
    return unread;
  }
}

/* ─────────────── Снять одного лида ─────────────── */

/**
 * Неудача шага. `stopsPass` — дальше в этом проходе рассыльщика не зовём
 * (429, 5xx, 401/403, обрыв, срок). `leadIds` — id записей, которым уже ушло
 * удаление (исход которого не подтвердился): строка хранит их до следующей
 * попытки.
 */
class DncStepError extends Error {
  constructor(
    readonly code: string,
    readonly stopsPass: boolean,
    readonly leadIds: readonly string[] = [],
  ) {
    super(code);
  }
}

function providerStep(e: unknown, leadIds: readonly string[] = []): DncStepError {
  if (e instanceof DncStepError) return e;
  if (e instanceof InstantlyApiError) {
    if (e.status === 429) return new DncStepError('rate_limited', true, leadIds);
    if (e.status >= 500) return new DncStepError(`provider_${e.status}`, true, leadIds);
    if (e.status === 401 || e.status === 403) return new DncStepError(`provider_${e.status}`, true, leadIds);
    return new DncStepError(`provider_${e.status}`, false, leadIds);
  }
  return new DncStepError('provider_unreachable', true, leadIds);
}

/** Кампания найдена в воркспейсе: «воркспейс|кампания» → когда (на процесс). */
const verifiedAt = new Map<string, number>();

/**
 * id записей лида с этим адресом в ЭТОЙ кампании. Каждая запись ответа обязана
 * быть из этой кампании (иначе фильтр проигнорирован — вывода нет); пустой
 * ответ — «нет» только когда он дочитан (нет курсора и страница не полная)
 * не больше чем за `maxPages` страниц.
 */
async function lookupLeadIds(
  list: typeof listLeads,
  campaignId: string,
  email: string,
  options: InstantlyRequestOptions,
  spend: () => void,
  maxPages: number,
): Promise<string[]> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  const matches: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    spend();
    let result: Awaited<ReturnType<typeof listLeads>>;
    try {
      result = await list(
        { campaign_id: campaignId, contacts: [email], limit: PAGE_SIZE, ...(cursor ? { starting_after: cursor } : {}) },
        options,
      );
    } catch (e) {
      throw providerStep(e);
    }
    if (!result || !Array.isArray(result.items) || result.items.length > PAGE_SIZE) {
      throw new DncStepError('lookup_shape', false);
    }
    for (const lead of result.items) {
      const id = str(lead?.id).trim();
      const leadEmail = str(lead?.email).trim().toLowerCase();
      const raw = lead?.campaign ?? null;
      const alias = lead?.campaign_id ?? null;
      if (
        !ANY_UUID_RE.test(id) ||
        !leadEmail ||
        (raw ?? alias) !== campaignId ||
        (raw != null && alias != null && raw !== alias) ||
        ids.has(id)
      ) {
        throw new DncStepError('lookup_unverified', false);
      }
      ids.add(id);
      if (leadEmail === email) matches.push(id);
    }
    const next = result.next_starting_after;
    if (next == null || next === '') {
      if (result.items.length === PAGE_SIZE) throw new DncStepError('lookup_incomplete', false);
      if (matches.length > MAX_MATCHES) throw new DncStepError('lookup_too_many', false);
      return matches;
    }
    if (typeof next !== 'string' || !next.trim() || cursors.has(next) || result.items.length === 0) {
      throw new DncStepError('lookup_pagination', false);
    }
    cursors.add(next);
    cursor = next;
  }
  throw new DncStepError('lookup_incomplete', false);
}

type RowOutcome =
  | { status: 'done'; leadIds: string[] }
  | { status: 'not_found'; note: string | null }
  /** Удаление ушло, а на проверочный поиск в этом проходе вызова не осталось. */
  | { status: 'unconfirmed'; leadIds: string[] };

/**
 * Сколько вызовов должно оставиться в проходе, чтобы строку начать: худший
 * случай до удаления включительно. Проверочный поиск — сверх, если остался
 * вызов (removeOne). Потолок прохода не меньше худшего случая с проверкой.
 */
function rowStartCost(needsCampaignCheck: boolean): number {
  return (needsCampaignCheck ? 1 : 0) + MAX_LOOKUP_PAGES + MAX_MATCHES;
}

async function removeOne(
  row: ClaimedRow,
  campaign: HeEngDncCampaign & { workspace: string },
  deps: Required<Pick<HeEngDncDeps, 'getCampaign' | 'listLeads' | 'deleteLead'>>,
  nowMs: number,
  spend: () => void,
  callsLeft: () => number,
): Promise<RowOutcome> {
  const options: InstantlyRequestOptions = {
    accountId: campaign.workspace,
    retryRateLimits: false,
    timeoutMs: READ_TIMEOUT_MS,
    timeoutIncludesBody: true,
    consumer: HE_ENG_DNC_CONSUMER,
  };
  const key = `${campaign.workspace}|${row.campaign_id}`;
  const seen = verifiedAt.get(key);
  if (seen === undefined || nowMs - seen >= VERIFIED_CAMPAIGN_TTL_MS) {
    spend();
    let live: Awaited<ReturnType<typeof getCampaign>>;
    try {
      live = await deps.getCampaign(row.campaign_id, options);
    } catch (e) {
      if (e instanceof InstantlyApiError && e.status === 404) {
        // Только в воркспейсе удачного чтения «404» значит «кампании нет».
        if (campaign.verified) return { status: 'not_found', note: 'campaign_gone' };
        throw new DncStepError('campaign_not_in_workspace', false);
      }
      throw providerStep(e);
    }
    if (!live || live.id !== row.campaign_id) throw new DncStepError('campaign_identity', false);
    if (verifiedAt.size >= 5_000) verifiedAt.clear();
    verifiedAt.set(key, nowMs);
  }

  const leadIds = await lookupLeadIds(deps.listLeads, row.campaign_id, row.email, options, spend, MAX_LOOKUP_PAGES);
  if (leadIds.length === 0) {
    // Прошлая попытка отправила удаление, а исход не подтвердился; теперь
    // адреса в кампании нет — это и есть подтверждение.
    return row.leadIds.length > 0 ? { status: 'done', leadIds: row.leadIds } : { status: 'not_found', note: null };
  }
  const attempted = [...new Set([...row.leadIds, ...leadIds])];
  for (const id of leadIds) {
    spend();
    try {
      const echo = await deps.deleteLead(id, { ...options, timeoutMs: DELETE_TIMEOUT_MS });
      const echoed = echo && typeof echo === 'object' && typeof echo.id === 'string' ? echo.id : null;
      if (echoed !== null && echoed.trim().toLowerCase() !== id.toLowerCase()) {
        throw new DncStepError('delete_answer_mismatch', true, attempted);
      }
    } catch (e) {
      if (e instanceof DncStepError) throw e;
      // «404»: записи нет — или путь не тот. Не вывод: решит проверочный поиск.
      if (e instanceof InstantlyApiError && e.status === 404) continue;
      if (e instanceof InstantlyApiError) throw providerStep(e, attempted);
      // Обрыв, срок, нечитаемый ответ, отказ deleteLead: что сделано — неизвестно.
      throw new DncStepError('delete_unclear', true, attempted);
    }
  }
  // Проверочный поиск: «снято» — только когда адреса в кампании больше нет.
  // Вызова на него в проходе не осталось — его сделает следующая попытка.
  if (callsLeft() < CONFIRM_LOOKUP_PAGES) return { status: 'unconfirmed', leadIds: attempted };
  let still: string[];
  try {
    still = await lookupLeadIds(deps.listLeads, row.campaign_id, row.email, options, spend, CONFIRM_LOOKUP_PAGES);
  } catch (e) {
    const step = providerStep(e);
    throw new DncStepError(step.stopsPass ? step.code : 'delete_unconfirmed', step.stopsPass, attempted);
  }
  if (still.length > 0) throw new DncStepError('delete_unconfirmed', false, attempted);
  return { status: 'done', leadIds: attempted };
}

/* ─────────────── Проход воркера ─────────────── */

interface ClaimedRow {
  id: string;
  user_id: string;
  email: string;
  campaign_id: string;
  workspace: string | null;
  /** Уже с учётом этого взятия. */
  attempts: number;
  /** id записей, которым прошлая попытка отправила удаление без подтверждения. */
  leadIds: string[];
}

function parseClaimed(raw: unknown): ClaimedRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaimedRow[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const email = normalizeBlockedEmail(r?.email);
    if (
      !r || !str(r.id) || !str(r.user_id) || !email || !str(r.campaign_id) ||
      typeof r.attempts !== 'number' || !Number.isSafeInteger(r.attempts) || r.attempts < 1
    ) {
      continue;
    }
    out.push({
      id: str(r.id),
      user_id: str(r.user_id),
      email,
      campaign_id: str(r.campaign_id),
      workspace: str(r.workspace) || null,
      attempts: r.attempts,
      leadIds: Array.isArray(r.lead_ids)
        ? (r.lead_ids as unknown[]).filter((x): x is string => typeof x === 'string' && ANY_UUID_RE.test(x))
        : [],
    });
  }
  return out;
}

export interface HeEngDncPassReport {
  enabled: boolean;
  intentsExpanded: number;
  /** Заявки, которые ждут конца запуска клиента (переведены в 'after_launch' или ждут дальше). */
  intentsWatching: number;
  intentsRetried: number;
  intentsFailed: number;
  claimed: number;
  done: number;
  notFound: number;
  cancelled: number;
  retried: number;
  failed: number;
  /** Взятые, но не начатые (срок, потолок вызовов, остановка): возвращены без траты попытки. */
  released: number;
  /** Удаление ушло, проверочного поиска в проходе не хватило: возвращены без траты попытки, с id записи. */
  awaitingConfirmation: number;
  /** Вызовов рассыльщика за проход. */
  calls: number;
  stoppedBy: 'rate_limited' | 'provider' | 'budget' | 'cutoff' | 'stop' | null;
}

function emptyReport(enabled: boolean): HeEngDncPassReport {
  return {
    enabled,
    intentsExpanded: 0,
    intentsWatching: 0,
    intentsRetried: 0,
    intentsFailed: 0,
    claimed: 0,
    done: 0,
    notFound: 0,
    cancelled: 0,
    retried: 0,
    failed: 0,
    released: 0,
    awaitingConfirmation: 0,
    calls: 0,
    stoppedBy: null,
  };
}

let missingWarned = false;
let noInstantlyDbWarned = false;

/**
 * Один проход (шапка, п. 4). Выключено — ни одного запроса. НЕ БРОСАЕТ.
 */
export async function runHeEngDncRemovalPass(opts: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  log: HeEngDncLog;
  shouldStop?: () => boolean;
  env?: NodeJS.ProcessEnv;
  deps?: HeEngDncDeps;
}): Promise<HeEngDncPassReport> {
  if (!heEngDncRemovalEnabled(opts.env)) return emptyReport(false);
  const report = emptyReport(true);
  const db = opts.portalDb;
  const deps = opts.deps ?? {};
  const clock = deps.now ?? (() => Date.now());
  const notify = deps.notify ?? notifyHeEngSending;
  const call = {
    getCampaign: deps.getCampaign ?? getCampaign,
    listLeads: deps.listLeads ?? listLeads,
    deleteLead: deps.deleteLead ?? deleteLead,
  };
  const failedByUser = new Map<string, { removals: number; intents: number; reason: string }>();
  const noteFailed = (userId: string, what: 'removals' | 'intents', reason: string) => {
    const f = failedByUser.get(userId) ?? { removals: 0, intents: 0, reason };
    f[what] += 1;
    f.reason = reason;
    failedByUser.set(userId, f);
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  try {
    if (!opts.instantlyDb) {
      if (!noInstantlyDbWarned) {
        noInstantlyDbWarned = true;
        opts.log('warn', '[eng-dnc] БД рассыльщика не настроена — снятие с кампаний не идёт');
      }
      return report;
    }
    // 1. Заявки, которые роут не развернул ('pending'), и заявки, ждущие
    //    конца запуска клиента ('after_launch', шапка п. 3a).
    const { data: intentRows, error: intentErr } = await db
      .from(HE_ENG_DNC_INTENTS_TABLE)
      .select('id, user_id, emails, attempts, status, skip_campaign_id, watch_from, created_at')
      .in('status', ['pending', 'after_launch'])
      .lte('next_at', iso(clock()))
      .order('next_at', { ascending: true })
      .limit(HE_ENG_DNC_INTENTS_PER_PASS);
    if (intentErr) {
      if (isMissing(intentErr)) {
        if (!missingWarned) {
          missingWarned = true;
          opts.log('warn', '[eng-dnc] таблиц he_eng_dnc_* нет (миграция 20261014_0005) — снятие с кампаний не идёт');
        }
        return report;
      }
      opts.log('warn', `[eng-dnc] ${pgText('заявки не прочитались', intentErr)}`);
    }
    for (const raw of (intentErr ? [] : (intentRows ?? [])) as Array<Record<string, unknown>>) {
      if (opts.shouldStop?.()) break;
      const id = str(raw.id);
      const userId = str(raw.user_id);
      const attempts = typeof raw.attempts === 'number' && Number.isSafeInteger(raw.attempts) ? raw.attempts : null;
      const emails = Array.isArray(raw.emails) ? raw.emails.filter((e): e is string => typeof e === 'string') : [];
      const status = raw.status === 'after_launch' ? 'after_launch' : raw.status === 'pending' ? 'pending' : null;
      const watching = status === 'after_launch';
      if (!id || !userId || attempts === null || !status) continue;
      const taken = await db
        .from(HE_ENG_DNC_INTENTS_TABLE)
        .update({ attempts: attempts + 1, next_at: iso(clock() + HE_ENG_DNC_LEASE_MS), updated_at: iso(clock()) })
        .eq('id', id)
        .eq('status', status)
        .eq('attempts', attempts)
        .select('id');
      if (taken.error || !Array.isArray(taken.data) || taken.data.length === 0) continue;
      const nowAttempts = attempts + 1;
      // Момент просьбы клиента; нет его — разворот откажет (enqueue_failed) и
      // заявка пойдёт по обычным повторам до 'failed' и алерта. У заявки
      // 'after_launch' — момент этого разворота: запуск кончился, и проверить
      // заново надо всё, что проверено до сих пор, в том числе во время него.
      const since = watching ? iso(clock()) : str(raw.created_at);
      const res = await expandHeEngDncEmails({
        portalDb: db,
        instantlyDb: opts.instantlyDb,
        userId,
        emails,
        since,
        skipCampaignId: str(raw.skip_campaign_id) || null,
        holdWhileLaunchRunning: watching,
        deps,
      });
      if (res.ok && res.launchRunning) {
        // Запуск клиента идёт: 'pending' уже разложена по известным кампаниям и
        // начинает ждать; 'after_launch' ждёт дальше, попытка не тратится.
        const fromMs = Date.parse(str(raw.watch_from) || str(raw.created_at));
        const overdue = watching && Number.isFinite(fromMs) && clock() - fromMs >= HE_ENG_DNC_WATCH_MAX_MS;
        const patch = overdue
          ? { status: 'failed', last_error: 'launch_still_running', updated_at: iso(clock()) }
          : watching
            ? { attempts, next_at: iso(clock() + HE_ENG_DNC_WATCH_POLL_MS), updated_at: iso(clock()) }
            : watchPatch(clock());
        const { data: moved, error } = await db
          .from(HE_ENG_DNC_INTENTS_TABLE)
          .update(patch)
          .eq('id', id)
          .eq('status', status)
          .eq('attempts', nowAttempts)
          .select('id');
        const ok = !error && Array.isArray(moved) && moved.length > 0;
        if (!ok) opts.log('warn', `[eng-dnc] заявка ${id}: запуск клиента идёт, а исход не записался — её возьмут снова после аренды`);
        if (!watching) report.intentsExpanded += 1;
        if (overdue) {
          if (ok) {
            report.intentsFailed += 1;
            noteFailed(userId, 'intents', 'launch_still_running');
          }
          opts.log('warn', `[eng-dnc] заявка ${id} (клиент ${userId}): запуск не кончился за ${HE_ENG_DNC_WATCH_MAX_MS / 3_600_000} ч — сдалась`);
        } else {
          report.intentsWatching += 1;
        }
        continue;
      }
      if (res.ok) {
        const { error } = await db.from(HE_ENG_DNC_INTENTS_TABLE).delete().eq('id', id);
        if (error) opts.log('warn', `[eng-dnc] заявка ${id} разложена, но не удалена — разложится ещё раз после аренды`);
        report.intentsExpanded += 1;
        continue;
      }
      const giveUp = nowAttempts >= HE_ENG_DNC_MAX_ATTEMPTS;
      const { error } = await db
        .from(HE_ENG_DNC_INTENTS_TABLE)
        .update({
          ...(giveUp ? { status: 'failed' } : { next_at: iso(clock() + heEngDncBackoffMs(nowAttempts)) }),
          last_error: `${res.code}: ${res.detail}`.slice(0, 300),
          updated_at: iso(clock()),
        })
        .eq('id', id)
        .eq('status', status)
        .eq('attempts', nowAttempts);
      if (error) opts.log('warn', `[eng-dnc] ${pgText(`исход заявки ${id} не записался`, error)}`);
      if (giveUp && !error) {
        report.intentsFailed += 1;
        noteFailed(userId, 'intents', res.code);
      } else {
        report.intentsRetried += 1;
      }
      opts.log('warn', `[eng-dnc] заявка ${id} (клиент ${userId}) не разложилась: ${res.code} ${res.detail}`.slice(0, 400));
    }

    if (opts.shouldStop?.()) {
      report.stoppedBy = 'stop';
      return report;
    }

    // 2. Строки очереди.
    const claim = await db.rpc('he_eng_dnc_claim', {
      p_limit: HE_ENG_DNC_ROWS_PER_PASS,
      p_lease_seconds: Math.ceil(HE_ENG_DNC_LEASE_MS / 1000),
    });
    if (claim.error) {
      opts.log('warn', `[eng-dnc] ${pgText('строки не взяты', claim.error)}`);
      return report;
    }
    const rows = parseClaimed(claim.data);
    report.claimed = rows.length;
    if (rows.length === 0) return report;

    // Исход строки — условной записью по взятию (status 'queued' и attempts
    // этого взятия). Не легла — строку возьмут снова после аренды, и повтор
    // безопасен (см. шапку, «Повторы»).
    const finish = async (row: ClaimedRow, patch: Record<string, unknown>): Promise<boolean> => {
      try {
        const { data, error } = await db
          .from(HE_ENG_DNC_REMOVALS_TABLE)
          .update({ ...patch, updated_at: iso(clock()) })
          .eq('id', row.id)
          .eq('status', 'queued')
          .eq('attempts', row.attempts)
          .select('id');
        if (!error && Array.isArray(data) && data.length > 0) return true;
      } catch {
        // то же, что ошибка ответа
      }
      opts.log('warn', `[eng-dnc] исход строки ${row.id} не записался — её возьмут снова после аренды`);
      return false;
    };
    const settle = async (row: ClaimedRow, status: 'done' | 'not_found' | 'cancelled' | 'failed', extra: Record<string, unknown> = {}) =>
      finish(row, { status, settled_at: iso(clock()), ...extra });
    const retry = async (row: ClaimedRow, code: string, workspace?: string | null, leadIds: readonly string[] = []) => {
      const giveUp = row.attempts >= HE_ENG_DNC_MAX_ATTEMPTS;
      // Удаление ушло, а исход не подтвердился: id остаются в строке до
      // следующей попытки (removeOne), и у 'failed' — для сотрудника.
      const extra = {
        ...(workspace ? { workspace } : {}),
        ...(leadIds.length > 0 ? { lead_ids: [...new Set([...row.leadIds, ...leadIds])] } : {}),
      };
      if (giveUp) {
        if (await settle(row, 'failed', { last_error: code, ...extra })) {
          report.failed += 1;
          noteFailed(row.user_id, 'removals', code);
        }
        return;
      }
      if (await finish(row, { next_at: iso(clock() + heEngDncBackoffMs(row.attempts)), last_error: code, ...extra })) {
        report.retried += 1;
      }
    };
    // Взятая, но не начатая строка: попытка не потрачена — возвращается как была.
    const release = async (row: ClaimedRow) => {
      if (await finish(row, { attempts: row.attempts - 1, next_at: iso(clock()) })) report.released += 1;
    };

    // Записи о запуске и список — на клиента, заново на каждом проходе.
    const context = new Map<string, { campaigns: Map<string, HeEngDncCampaign>; listed: Set<string> } | null>();
    for (const userId of [...new Set(rows.map((r) => r.user_id))]) {
      const read = await readHeEngDncCampaigns(db, opts.instantlyDb, userId, {
        workspaceConfigured: deps.workspaceConfigured,
      });
      const listed = read.ok
        ? await readListed(opts.instantlyDb, userId, rows.filter((r) => r.user_id === userId).map((r) => r.email))
        : null;
      if (!read.ok) opts.log('warn', `[eng-dnc] записи о запуске клиента ${userId} не прочитались: ${read.detail}`);
      else if (!listed) opts.log('warn', `[eng-dnc] список клиента ${userId} не прочитался`);
      context.set(userId, read.ok && listed ? { campaigns: read.campaigns, listed } : null);
    }

    // Счёт вызовов — до самого вызова: и неудачный, и брошенный засчитаны.
    const spend = () => {
      report.calls += 1;
    };
    // Срок START_CUTOFF_MS — с этого момента: чтения выше (записи о запуске,
    // списки) могут быть долгими, и тогда первая строка всё равно начнётся.
    const rowsStartedMs = clock();
    for (const row of rows) {
      if (report.stoppedBy) {
        await release(row);
        continue;
      }
      const ctx = context.get(row.user_id);
      if (!ctx) {
        await retry(row, 'records_unreadable');
        continue;
      }
      if (!ctx.listed.has(row.email)) {
        if (await settle(row, 'cancelled', { last_error: null })) report.cancelled += 1;
        continue;
      }
      const campaign = ctx.campaigns.get(row.campaign_id);
      if (!campaign) {
        // Кампании нет в записях клиента — рассыльщика не зовём никогда.
        if (await settle(row, 'failed', { last_error: 'campaign_not_in_records' })) {
          report.failed += 1;
          noteFailed(row.user_id, 'removals', 'campaign_not_in_records');
        }
        continue;
      }
      if (!campaign.workspace) {
        await retry(row, 'workspace_unknown');
        continue;
      }
      const nowMs = clock();
      const seen = verifiedAt.get(`${campaign.workspace}|${row.campaign_id}`);
      const needsCheck = seen === undefined || nowMs - seen >= VERIFIED_CAMPAIGN_TTL_MS;
      const worstCase = rowStartCost(needsCheck);
      if (opts.shouldStop?.()) report.stoppedBy = 'stop';
      else if (nowMs - rowsStartedMs >= START_CUTOFF_MS) report.stoppedBy = 'cutoff';
      else if (HE_ENG_DNC_CALLS_PER_PASS - report.calls < worstCase) report.stoppedBy = 'budget';
      if (report.stoppedBy) {
        await release(row);
        continue;
      }
      try {
        const out = await removeOne(
          row,
          { ...campaign, workspace: campaign.workspace },
          call,
          nowMs,
          spend,
          () => HE_ENG_DNC_CALLS_PER_PASS - report.calls,
        );
        if (out.status === 'done') {
          if (await settle(row, 'done', { lead_ids: out.leadIds, last_error: null, workspace: campaign.workspace })) report.done += 1;
        } else if (out.status === 'unconfirmed') {
          // Попытка не потрачена: следующий поиск этой строки и есть проверка.
          if (
            await finish(row, {
              attempts: row.attempts - 1,
              next_at: iso(clock()),
              lead_ids: out.leadIds,
              last_error: 'awaiting_confirmation',
              workspace: campaign.workspace,
            })
          ) {
            report.awaitingConfirmation += 1;
          }
        } else if (await settle(row, 'not_found', { last_error: out.note, workspace: campaign.workspace })) {
          report.notFound += 1;
        }
      } catch (e) {
        const step = e instanceof DncStepError ? e : providerStep(e);
        await retry(row, step.code, campaign.workspace, step.leadIds);
        if (step.stopsPass) report.stoppedBy = step.code === 'rate_limited' ? 'rate_limited' : 'provider';
      }
    }
    // Ни одна взятая строка не начата, и не из-за остановки воркера: так быть
    // не должно (первая строка начинается всегда) — громко, чтобы застой не
    // прятался в info-строке.
    if (report.claimed > 0 && report.released === report.claimed && report.calls === 0 && report.stoppedBy !== 'stop') {
      opts.log('warn', `[eng-dnc] проход вернул все ${report.claimed} взятые строки, не начав ни одной (стоп: ${report.stoppedBy ?? '—'})`);
    }
    return report;
  } catch (e) {
    opts.log('warn', `[eng-dnc] проход упал: ${errText(e)}`);
    return report;
  } finally {
    for (const [userId, f] of failedByUser) {
      void notify({ kind: 'dnc_removal_failed', userId, removals: f.removals, intents: f.intents, reason: f.reason });
    }
  }
}

/**
 * Обёртка прохода для цикла воркера (как у фоновой проверки заблокированных,
 * engBlockedSweep): выключено — сразу выход без запросов; не чаще
 * HE_ENG_DNC_TICK_MS; не больше одного прохода за раз; очередь джоб держится
 * не дольше HE_ENG_DNC_QUEUE_HOLD_MS — проход, не уложившийся в срок, доходит
 * фоном, а следующий не начнётся, пока он не кончится. `maybeRun` НЕ БРОСАЕТ.
 */
export function createHeEngDncRemovalTicker(opts: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  log: HeEngDncLog;
  shouldStop?: () => boolean;
  env?: NodeJS.ProcessEnv;
  holdMs?: number;
  run?: typeof runHeEngDncRemovalPass;
}): { maybeRun: () => Promise<void> } {
  let nextAtMs = 0;
  let inFlight: Promise<void> | null = null;
  const run = opts.run ?? runHeEngDncRemovalPass;
  const holdMs = opts.holdMs ?? HE_ENG_DNC_QUEUE_HOLD_MS;
  return {
    maybeRun: async () => {
      if (!heEngDncRemovalEnabled(opts.env)) return;
      const nowMs = Date.now();
      if (inFlight || nowMs < nextAtMs) return;
      nextAtMs = nowMs + HE_ENG_DNC_TICK_MS;
      const current: Promise<void> = run({
        portalDb: opts.portalDb,
        instantlyDb: opts.instantlyDb,
        log: opts.log,
        shouldStop: opts.shouldStop,
        env: opts.env,
      })
        .then((r) => {
          if (r.intentsExpanded || r.intentsWatching || r.intentsRetried || r.intentsFailed || r.claimed) {
            opts.log(
              'info',
              `[eng-dnc] заявки: разложено ${r.intentsExpanded}, ждут конца запуска ${r.intentsWatching}, `
                + `повтор ${r.intentsRetried}, сдались ${r.intentsFailed}; `
                + `строк взято ${r.claimed}: снято ${r.done}, нет в кампании ${r.notFound}, убраны из списка ${r.cancelled}, `
                + `повтор ${r.retried}, сдались ${r.failed}, возвращено ${r.released}, `
                + `ждут проверки удаления ${r.awaitingConfirmation}; вызовов ${r.calls}`
                + `${r.stoppedBy ? `, стоп: ${r.stoppedBy}` : ''}; ${Date.now() - nowMs} мс`,
            );
          }
        })
        .catch((e: unknown) => {
          opts.log('warn', `[eng-dnc] проход бросил: ${errText(e)}`);
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = current;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const hold = new Promise<'hold'>((resolve) => {
        timer = setTimeout(() => resolve('hold'), holdMs);
      });
      const outcome = await Promise.race([current.then(() => 'done' as const), hold]);
      if (timer) clearTimeout(timer);
      if (outcome === 'hold') {
        opts.log('warn', `[eng-dnc] проход дольше ${holdMs} мс — очередь не ждёт, он доходит фоном`);
      }
    },
  };
}
