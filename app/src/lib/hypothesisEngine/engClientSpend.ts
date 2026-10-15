/**
 * Потолок расхода ENG НА КЛИЕНТА — сумма по ВСЕМ его проектам рынка 'us'.
 * ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН.
 *
 * ЗАЧЕМ. Потолок проекта (spendCeiling.ts, HE_US_PROJECT_SPEND_CAP_USD /
 * HE_US_PROJECT_DAY_SPEND_CAP_USD) считает каждый проект отдельно, а новый
 * проект начинает с нуля — десять проектов обходят его в десять раз. Здесь
 * тот же журнал (application_logs 'he_provider_usage'), но сложенный по
 * проектам клиента (he_projects.created_by = клиент, market = 'us').
 *
 * ВЫКЛЮЧЕН — ЗНАЧИТ НИЧЕГО. Пока ни HE_US_CLIENT_SPEND_CAP_USD, ни
 * HE_US_CLIENT_DAY_SPEND_CAP_USD не заданы (дефолт), проверка отвечает 'off'
 * до первого запроса к БД.
 *
 * ДВА ПОРОГА:
 *  - 'total' — расход клиента за всё время журнала — по его проектам, которые
 *              есть сейчас (см. «СУММА» ниже);
 *  - 'day'   — за СКОЛЬЗЯЩИЕ последние 24 часа до момента проверки
 *              (HE_SPEND_DAY_WINDOW_MS), как у потолка суток проекта.
 *
 * КАК СЧИТАЕТСЯ. Одной суммой на сервере — функция he_client_provider_spend_sum
 * (миграция 20261010_0001): она складывает he_provider_spend_sum
 * (20261009_0001) по проектам клиента, правила разбора строки те же. Сумма —
 * НИЖНЯЯ граница настоящего расхода по тем же причинам, что у потолка проекта
 * (шапка spendCeiling.ts: обращения без цены, Serper без тарифа
 * HE_US_SERPER_USD_PER_1000, конструктор баз и т.д.).
 *
 * СУММА — ТОЛЬКО ПО ПРОЕКТАМ, КОТОРЫЕ ЕЩЁ ЕСТЬ. Клиента с журналом связывает
 * строка he_projects (created_by): у удалённого проекта журнал остаётся
 * (application_logs, request_id = id проекта), но к клиенту его больше ничто
 * не привязывает, и его расход из суммы клиента уходит навсегда. Клиентского
 * удаления проекта нет (один аккаунт — один сайт, решение владельца
 * 10.10.2026: DELETE у api/client/eng/projects/[id] нет), но проект,
 * удалённый другим путём (руками в БД), в «пожизненный» порог 'total' не
 * входит. Суточный 'day' это задевает лишь на 24 часа после удаления. Перед включением 'total' — проверка только на
 * чтение (заметки выката, шаг 8): есть ли строки he_provider_usage, у чьего
 * request_id нет строки he_projects —
 *   select l.request_id, count(*) from public.application_logs l
 *    where l.source = 'he_provider_usage'
 *      and not exists (select 1 from public.he_projects p where p.id::text = l.request_id)
 *    group by l.request_id;
 * Строки есть — расход этих проектов порог 'total' не видит (решение владельца).
 *
 * НЕИЗВЕСТНО — ЗНАЧИТ ПУСКАЕМ (fail-open), как у потолка проекта: функции нет
 * (миграция не применена — 42883 / PGRST202), сбой чтения, срок проверки
 * HE_SPEND_CHECK_TIMEOUT_MS. Постраничного запасного пути здесь нет: без
 * миграции клиентский потолок не держит, и `failure` это называет.
 *
 * ЧТО ДЕЛАЕТ 'over' — решает вызывающий. Этот модуль только отвечает; он без
 * логгера и без `server-only`, его может звать и воркер (ворота дочейна,
 * реконсилер, ночной добор — по id проекта, checkHeClientSpendCeilingForProject).
 * Единственное исключение — алерт общего потолка ENG (ниже): его шлёт сама
 * проверка, потому что достигнутый общий потолок видят и пути, которые
 * алерта не шлют (гейт платных шагов кабинета, engPaidAccess).
 *
 * ОБЩИЙ ПОТОЛОК ENG (HE_US_ENG_DAY_SPEND_CAP_USD, ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН) — третий
 * порог этой же проверки: расход ВСЕГО рынка us (все us-проекты всех
 * клиентов, удалённые тоже) за скользящие последние 24 часа, одной суммой на
 * сервере (he_us_provider_spend_sum, миграция 20261015_0011). Зачем: пока ENG
 * платит с того же ключа Requesty и аккаунта Serper, что RU (VE2 и
 * staff-инструмент), потолки проекта и клиента не ограничивают поток новых
 * аккаунтов, и он мог бы выесть общий баланс. Достигнут — вердикт 'over' с
 * порогом 'eng_day', и каждый платный путь ENG его не ставит: гейт кабинета
 * отказывает кодом spend_day_limit с НЕЙТРАЛЬНОЙ фразой
 * (engPaidAccess.ENG_SPEND_PAUSED_GLOBAL_TEXT — аккаунт клиента ничего не
 * достиг), ворота воркера, реконсилер и кнопки (через
 * spendCeiling.checkHeSpendCeiling) пропускают шаг, ночной добор — ночь. Но
 * DURABLE-ПАУЗ ОН НЕ ПИШЕТ (ни 'spend_ceiling' автопилота, ни паузы добора):
 * порог общий и скользящий, отпускает сам, а пауза на каждом проекте
 * снималась бы только руками (spendCeiling.ts, шапка «ОБЩИЙ потолок ENG»).
 * RU и VE2 он не трогает: проверку зовут только пути ENG, а по id проекта она
 * отвечает 'off' всему, что не 'us'. Алерт команде — один на окно
 * (HE_OPS_CAPACITY_REPEAT_MS, 6 ч) на процесс, через health-бот
 * (lib/telegram/workerAlert); не принятый Telegram'ом — окно снимается, и
 * следующая проверка напишет снова. Неизвестно (нет функции, сбой, срок
 * HE_ENG_DAY_SPEND_CHECK_TIMEOUT_MS = 5 с — короче общего, чтобы медленная
 * сумма не держала каждое нажатие 20 с) — пускаем (fail-open), как у
 * остальных порогов; но HE_ENG_DAY_UNKNOWN_ALERT_AFTER «неизвестно» подряд —
 * отдельный алерт команде (тоже раз в 6 ч на процесс): этот порог — стоп-кран
 * общего с RU баланса, и молча выключаться ему нельзя. Сумму держит частичный
 * индекс 20261015_0012_he_provider_usage_created_idx.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendWorkerAlert, type WorkerAlert } from '@/lib/telegram/workerAlert';
import { HE_OPS_CAPACITY_REPEAT_MS, HE_OPS_SEND_TIMEOUT_MS } from './opsAlert';
import { HE_SPEND_CHECK_TIMEOUT_MS, HE_SPEND_DAY_WINDOW_MS, readHeSpendCaps } from './spendCeiling';

/** Потолок клиента за всё время журнала, USD. Пусто/нет — выключен (дефолт). */
export const HE_US_CLIENT_SPEND_CAP_ENV = 'HE_US_CLIENT_SPEND_CAP_USD';
/** Потолок клиента за скользящие последние 24 часа, USD. Пусто/нет — выключен (дефолт). */
export const HE_US_CLIENT_DAY_SPEND_CAP_ENV = 'HE_US_CLIENT_DAY_SPEND_CAP_USD';
/**
 * ОБЩИЙ потолок ENG за скользящие последние 24 часа, USD: расход всех
 * us-проектов всех клиентов (шапка, «ОБЩИЙ ПОТОЛОК ENG»). Пусто/нет — выключен
 * (дефолт).
 */
export const HE_US_ENG_DAY_SPEND_CAP_ENV = 'HE_US_ENG_DAY_SPEND_CAP_USD';
/**
 * Срок чтения суммы общего потолка ENG. Короче общего срока проверки
 * (spendCeiling.HE_SPEND_CHECK_TIMEOUT_MS, 20 с): сумма идёт у КАЖДОГО
 * платного нажатия кабинета, и медленная БД не должна держать его 20 с,
 * чтобы потом всё равно пустить (fail-open). Суточная сумма по частичному
 * индексу (20261015_0012_he_provider_usage_created_idx) укладывается в
 * миллисекунды; 5 с — уже сбой, о нём — алерт ниже.
 */
export const HE_ENG_DAY_SPEND_CHECK_TIMEOUT_MS = 5_000;
/**
 * Сколько ответов «неизвестно» общего потолка ENG подряд (в этом процессе)
 * до алерта команде «потолок не проверяется». Один сбой — блип; три подряд —
 * порог фактически выключен. Удачное чтение счёт обнуляет.
 */
export const HE_ENG_DAY_UNKNOWN_ALERT_AFTER = 3;

export interface HeClientSpendCaps {
  /** null — порог выключен. */
  totalCapUsd: number | null;
  /** null — порог выключен. */
  dayCapUsd: number | null;
  /**
   * Общий потолок ENG за 24 часа (HE_US_ENG_DAY_SPEND_CAP_USD). null или поля
   * нет — выключен: вызывающий, собравший пороги сам, общего не включает.
   */
  engDayCapUsd?: number | null;
  /** null — Serper в сумму не входит. */
  serperUsdPer1000: number | null;
  /** Переменные с нечитаемым значением (0, минус, не число) — считаются не заданными. */
  rejected: string[];
}

function positiveUsd(raw: string | undefined): number | null | 'rejected' {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : 'rejected';
}

/**
 * Пороги из окружения — те же правила разбора, что у readHeSpendCaps: пусто
 * или нет — выключен; нечитаемое («0», «-5», «abc») — тоже выключен, но имя
 * едет в `rejected` («0» не означает «стоп для всех»). Тариф Serper берётся
 * у потолка проекта (HE_US_SERPER_USD_PER_1000, тот же разбор): оба потолка
 * оценивают поиск одинаково.
 */
export function readHeClientSpendCaps(env: NodeJS.ProcessEnv = process.env): HeClientSpendCaps {
  const rejected: string[] = [];
  const read = (name: string): number | null => {
    const value = positiveUsd(env[name]);
    if (value === 'rejected') {
      rejected.push(name);
      return null;
    }
    return value;
  };
  return {
    totalCapUsd: read(HE_US_CLIENT_SPEND_CAP_ENV),
    dayCapUsd: read(HE_US_CLIENT_DAY_SPEND_CAP_ENV),
    engDayCapUsd: read(HE_US_ENG_DAY_SPEND_CAP_ENV),
    serperUsdPer1000: readHeSpendCaps(env).serperUsdPer1000,
    rejected,
  };
}

/** Включён ли хоть один порог этой проверки: клиента или общий потолок ENG. */
export function heClientSpendCeilingOn(
  caps: Pick<HeClientSpendCaps, 'totalCapUsd' | 'dayCapUsd' | 'engDayCapUsd'>,
): boolean {
  return heOwnClientCapsOn(caps) || heEngDayCapOf(caps) !== null;
}

function heOwnClientCapsOn(caps: Pick<HeClientSpendCaps, 'totalCapUsd' | 'dayCapUsd'>): boolean {
  return caps.totalCapUsd !== null || caps.dayCapUsd !== null;
}

function heEngDayCapOf(caps: Pick<HeClientSpendCaps, 'engDayCapUsd'>): number | null {
  return validCap(caps.engDayCapUsd ?? null);
}

/** Порог, которым называется «неизвестно», когда не прочиталось всё: первый включённый. */
function firstOnCap(caps: Pick<HeClientSpendCaps, 'totalCapUsd' | 'dayCapUsd'>): HeClientSpendCap {
  return caps.totalCapUsd !== null ? 'total' : caps.dayCapUsd !== null ? 'day' : 'eng_day';
}

/* ─────────────── Чистое решение ─────────────── */

/**
 * 'total' / 'day' — потолки клиента; 'eng_day' — общий потолок ENG за 24 часа
 * (кабинет отвечает на него кодом spend_day_limit, но своей нейтральной
 * фразой — engPaidAccess.engSpendLimitRefusal('eng_day')).
 */
export type HeClientSpendCap = 'total' | 'day' | 'eng_day';

/**
 *  - 'off'     — оба порога выключены;
 *  - 'over'    — известный расход ДОСТИГ порога (>=);
 *  - 'unknown' — у включённого порога расход неизвестен, и ни один порог не
 *                достигнут доказанно: вызывающий пускает;
 *  - 'under'   — у каждого включённого порога известный расход ниже него.
 */
export type HeClientSpendVerdict =
  | { kind: 'off' }
  | { kind: 'under' }
  | { kind: 'over'; cap: HeClientSpendCap; spendUsd: number; capUsd: number }
  | { kind: 'unknown'; cap: HeClientSpendCap };

const validCap = (value: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const knownSpend = (value: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Достигнут ли потолок клиента. Чистая. Порог за всё время проверяется первым. */
export function exceedsHeClientSpendCeiling(input: {
  totalSpendUsd: number | null;
  daySpendUsd: number | null;
  totalCapUsd: number | null;
  dayCapUsd: number | null;
}): HeClientSpendVerdict {
  const totalCap = validCap(input.totalCapUsd);
  const dayCap = validCap(input.dayCapUsd);
  if (totalCap === null && dayCap === null) return { kind: 'off' };
  const total = knownSpend(input.totalSpendUsd);
  const day = knownSpend(input.daySpendUsd);
  if (totalCap !== null && total !== null && total >= totalCap) {
    return { kind: 'over', cap: 'total', spendUsd: total, capUsd: totalCap };
  }
  if (dayCap !== null && day !== null && day >= dayCap) {
    return { kind: 'over', cap: 'day', spendUsd: day, capUsd: dayCap };
  }
  if (totalCap !== null && total === null) return { kind: 'unknown', cap: 'total' };
  if (dayCap !== null && day === null) return { kind: 'unknown', cap: 'day' };
  return { kind: 'under' };
}

/* ─────────────── Чтение суммы ─────────────── */

export interface HeClientSpend {
  /** Requesty с известной ценой + Serper по тарифу, если он задан. НИЖНЯЯ граница. */
  knownUsd: number;
  /** Обращения без цены (Serper без тарифа — все поиски). */
  unpricedCalls: number;
  calls: number;
  lostRows: number;
  skippedRows: number;
  /** Сколько us-проектов клиента сложено. */
  projects: number;
}

const CLIENT_SPEND_SUM_RPC = 'he_client_provider_spend_sum';
/** Сумма всего рынка us за окно (миграция 20261015_0011). */
const ENG_SPEND_SUM_RPC = 'he_us_provider_spend_sum';

function sumNumber(row: Record<string, unknown>, field: string, rpc: string = CLIENT_SPEND_SUM_RPC): number {
  const raw = row[field];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${rpc}: field ${field} is not a non-negative number`);
  }
  return value;
}

/**
 * Строка ответа функции суммы → расход. Колонки у функций клиента и всего
 * рынка одни и те же. Бросает на пустом ответе и мусоре в полях.
 */
function spendFromSumAnswer(rpc: string, data: unknown, tariff: number | null): HeClientSpend {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object') throw new Error(`${rpc}: empty answer`);
  const num = (field: string) => sumNumber(row, field, rpc);
  const priced = num('priced_usd');
  const credits = num('serper_credits');
  return {
    // Те же правила, что readHeProviderSpend: 9 знаков, Serper по тарифу.
    knownUsd: Number((priced + (tariff === null ? 0 : (credits * tariff) / 1000)).toFixed(9)),
    unpricedCalls:
      num('requesty_unpriced')
      + (tariff === null ? num('serper_calls') : num('serper_credits_unknown')),
    calls: num('calls'),
    lostRows: num('lost_rows'),
    skippedRows: num('skipped_rows'),
    projects: num('projects'),
  };
}

/**
 * Известный расход клиента по журналу за всё время или за окно [fromIso, toIso).
 * Бросает: функции нет (текст называет миграцию), сбой, мусор в ответе.
 */
export async function readHeClientProviderSpend(
  db: SupabaseClient,
  filter: { userId: string; fromIso?: string; toIso?: string; serperUsdPer1000: number | null },
): Promise<HeClientSpend> {
  const { data, error } = await db.rpc(CLIENT_SPEND_SUM_RPC, {
    p_user_id: filter.userId,
    p_from: filter.fromIso ?? null,
    p_to: filter.toIso ?? null,
  });
  if (error) {
    const missing = error.code === '42883' || error.code === 'PGRST202';
    throw new Error(
      missing
        ? `${CLIENT_SPEND_SUM_RPC} missing: migration 20261010_0001 not applied`
        : `${CLIENT_SPEND_SUM_RPC} rpc: ${error.code ?? 'error'}`,
    );
  }
  return spendFromSumAnswer(CLIENT_SPEND_SUM_RPC, data, filter.serperUsdPer1000);
}

/**
 * Известный расход ВСЕГО рынка us по журналу за окно [fromIso, toIso) — все
 * us-проекты всех клиентов (he_us_provider_spend_sum). `projects` — сколько
 * проектов дали строки за окно. Бросает: функции нет (текст называет
 * миграцию), сбой, мусор в ответе.
 */
export async function readHeEngProviderSpend(
  db: SupabaseClient,
  filter: { fromIso: string; toIso?: string; serperUsdPer1000: number | null },
): Promise<HeClientSpend> {
  const { data, error } = await db.rpc(ENG_SPEND_SUM_RPC, {
    p_from: filter.fromIso,
    p_to: filter.toIso ?? null,
  });
  if (error) {
    const missing = error.code === '42883' || error.code === 'PGRST202';
    throw new Error(
      missing
        ? `${ENG_SPEND_SUM_RPC} missing: migration 20261015_0011 not applied`
        : `${ENG_SPEND_SUM_RPC} rpc: ${error.code ?? 'error'}`,
    );
  }
  return spendFromSumAnswer(ENG_SPEND_SUM_RPC, data, filter.serperUsdPer1000);
}

/* ─────────────── Проверка ─────────────── */

export interface HeClientSpendCheck {
  verdict: HeClientSpendVerdict;
  caps: HeClientSpendCaps;
  /** Расход за всё время (только при включённом пороге 'total'). */
  total: HeClientSpend | null;
  /** Расход за последние 24 часа (только при включённом пороге 'day'). */
  day: HeClientSpend | null;
  /** Расход ВСЕГО рынка us за последние 24 часа (только при включённом общем потолке ENG). */
  engDay: HeClientSpend | null;
  /** Почему расход неизвестен (текст для лога, не для клиента); null — прочитан. */
  failure: string | null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Ответ проверки без порогов, которые не включены (общий вид «выключено»). */
function offCheck(caps: HeClientSpendCaps): HeClientSpendCheck {
  return { verdict: { kind: 'off' }, caps, total: null, day: null, engDay: null, failure: null };
}

/** Часть ответа про СОБСТВЕННЫЕ потолки клиента ('total' / 'day'). */
type HeOwnClientSpendPart = Pick<HeClientSpendCheck, 'verdict' | 'total' | 'day' | 'failure'>;

/**
 * Собственные потолки клиента (сумма по его us-проектам). Не бросает. Оба
 * выключены — 'off' без запросов.
 */
async function checkHeOwnClientCaps(
  db: SupabaseClient,
  args: { userId: string; caps: HeClientSpendCaps; now?: Date; timeoutMs?: number },
): Promise<HeOwnClientSpendPart> {
  const { caps } = args;
  if (!heOwnClientCapsOn(caps)) return { verdict: { kind: 'off' }, total: null, day: null, failure: null };
  const unknownCap: HeClientSpendCap = caps.totalCapUsd !== null ? 'total' : 'day';
  const timeoutMs = args.timeoutMs ?? HE_SPEND_CHECK_TIMEOUT_MS;
  try {
    const nowMs = (args.now ?? new Date()).getTime();
    const outcome = await withTimeout(
      Promise.all([
        caps.totalCapUsd !== null
          ? readHeClientProviderSpend(db, { userId: args.userId, serperUsdPer1000: caps.serperUsdPer1000 })
          : Promise.resolve(null),
        caps.dayCapUsd !== null
          ? readHeClientProviderSpend(db, {
            userId: args.userId,
            fromIso: new Date(nowMs - HE_SPEND_DAY_WINDOW_MS).toISOString(),
            toIso: new Date(nowMs).toISOString(),
            serperUsdPer1000: caps.serperUsdPer1000,
          })
          : Promise.resolve(null),
      ]),
      timeoutMs,
    );
    if (outcome === 'timeout') {
      return { verdict: { kind: 'unknown', cap: unknownCap }, total: null, day: null, failure: `check exceeded ${timeoutMs} ms` };
    }
    const [total, day] = outcome;
    return {
      total,
      day,
      failure: null,
      verdict: exceedsHeClientSpendCeiling({
        totalSpendUsd: total ? total.knownUsd : null,
        daySpendUsd: day ? day.knownUsd : null,
        totalCapUsd: caps.totalCapUsd,
        dayCapUsd: caps.dayCapUsd,
      }),
    };
  } catch (e) {
    return {
      verdict: { kind: 'unknown', cap: unknownCap },
      total: null,
      day: null,
      failure: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
    };
  }
}

/**
 * Свести ответ потолков клиента и общего потолка ENG. Доказанное 'over' важнее
 * всего (потолки клиента называются первыми: их «за всё время» — отказ
 * сильнее), затем 'unknown' (пускаем), затем 'under'.
 */
function mergeHeClientAndEngDay(
  caps: HeClientSpendCaps,
  own: HeOwnClientSpendPart,
  eng: HeEngDaySpendCheck,
): HeClientSpendCheck {
  const cv = own.verdict;
  const ev = eng.verdict;
  const verdict: HeClientSpendVerdict =
    cv.kind === 'over' ? cv
      : ev.kind === 'over' ? { kind: 'over', cap: 'eng_day', spendUsd: ev.spendUsd, capUsd: ev.capUsd }
        : cv.kind === 'unknown' ? cv
          : ev.kind === 'unknown' ? { kind: 'unknown', cap: 'eng_day' }
            : cv.kind === 'under' || ev.kind === 'under' ? { kind: 'under' }
              : { kind: 'off' };
  return {
    verdict,
    caps,
    total: own.total,
    day: own.day,
    engDay: eng.spend,
    failure: [own.failure, eng.failure ? `eng: ${eng.failure}` : null].filter(Boolean).join('; ') || null,
  };
}

/**
 * Проверить потолки клиента и общий потолок ENG. НИКОГДА НЕ БРОСАЕТ и не ждёт
 * дольше `timeoutMs` на чтение (плюс отправку алерта общего потолка — не
 * дольше HE_OPS_SEND_TIMEOUT_MS, и только у первой проверки в окне алерта).
 * Запросы: всё выключено — ноль; иначе по одной сумме на сервере на каждый
 * включённый порог, параллельно. `projectId` — только строке алерта.
 */
export async function checkHeClientSpendCeiling(
  db: SupabaseClient,
  args: { userId: string; caps?: HeClientSpendCaps; now?: Date; timeoutMs?: number; projectId?: string | null },
): Promise<HeClientSpendCheck> {
  const caps = args.caps ?? readHeClientSpendCaps();
  if (!heClientSpendCeilingOn(caps)) return offCheck(caps);
  const [own, eng] = await Promise.all([
    checkHeOwnClientCaps(db, { userId: args.userId, caps, now: args.now, timeoutMs: args.timeoutMs }),
    checkHeEngDaySpendCeiling(db, {
      capUsd: caps.engDayCapUsd ?? null,
      serperUsdPer1000: caps.serperUsdPer1000,
      now: args.now,
      timeoutMs: args.timeoutMs,
      asker: { userId: args.userId, projectId: args.projectId ?? null },
    }),
  ]);
  return mergeHeClientAndEngDay(caps, own, eng);
}

/**
 * То же по id проекта — для путей без пользователя в руках (ворота дочейна
 * воркера, реконсилер, ночной добор). Проект не 'us' — 'off' (ни потолки
 * клиента, ни общий потолок ENG не для него); проект или рынок не прочитался —
 * 'unknown' (пускаем); владельца нет — потолки клиента 'unknown', общий
 * потолок ENG проверяется (ему владелец не нужен).
 */
export async function checkHeClientSpendCeilingForProject(
  db: SupabaseClient,
  args: { projectId: string; caps?: HeClientSpendCaps; now?: Date; timeoutMs?: number },
): Promise<HeClientSpendCheck & { userId: string | null }> {
  const caps = args.caps ?? readHeClientSpendCaps();
  if (!heClientSpendCeilingOn(caps)) return { ...offCheck(caps), userId: null };
  const unknownCap = firstOnCap(caps);
  try {
    const { data, error } = await db
      .from('he_projects')
      .select('created_by, market')
      .eq('id', args.projectId)
      .maybeSingle();
    const row = (data ?? null) as { created_by?: unknown; market?: unknown } | null;
    if (error || !row) {
      return {
        ...offCheck(caps),
        verdict: { kind: 'unknown', cap: unknownCap },
        failure: error ? `he_projects read: ${error.code ?? 'error'}` : 'project not found',
        userId: null,
      };
    }
    if (row.market !== 'us') return { ...offCheck(caps), userId: null };
    if (typeof row.created_by !== 'string' || !row.created_by) {
      const own: HeOwnClientSpendPart = heOwnClientCapsOn(caps)
        ? { verdict: { kind: 'unknown', cap: unknownCap }, total: null, day: null, failure: 'project has no owner' }
        : { verdict: { kind: 'off' }, total: null, day: null, failure: null };
      const eng = await checkHeEngDaySpendCeiling(db, {
        capUsd: caps.engDayCapUsd ?? null,
        serperUsdPer1000: caps.serperUsdPer1000,
        now: args.now,
        timeoutMs: args.timeoutMs,
        asker: { projectId: args.projectId },
      });
      return { ...mergeHeClientAndEngDay(caps, own, eng), userId: null };
    }
    const check = await checkHeClientSpendCeiling(db, {
      userId: row.created_by,
      caps,
      now: args.now,
      timeoutMs: args.timeoutMs,
      projectId: args.projectId,
    });
    return { ...check, userId: row.created_by };
  } catch (e) {
    return {
      ...offCheck(caps),
      verdict: { kind: 'unknown', cap: unknownCap },
      failure: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
      userId: null,
    };
  }
}

/* ─────────────── Общий потолок ENG ─────────────── */

/**
 *  - 'off'     — порог не задан (запросов нет);
 *  - 'over'    — известный расход рынка us за 24 часа ДОСТИГ порога (>=);
 *  - 'unknown' — расход не прочитан (нет функции, сбой, срок): пускаем;
 *  - 'under'   — известная часть ниже порога.
 */
export type HeEngDaySpendVerdict =
  | { kind: 'off' }
  | { kind: 'under' }
  | { kind: 'over'; spendUsd: number; capUsd: number }
  | { kind: 'unknown' };

export interface HeEngDaySpendCheck {
  verdict: HeEngDaySpendVerdict;
  /** Расход рынка us за окно (null — порог выключен или не прочитано). */
  spend: HeClientSpend | null;
  /** Почему расход неизвестен (текст для лога); null — прочитан. */
  failure: string | null;
}

/** Кто упёрся в общий потолок первым — строка алерта; оба поля необязательны. */
export interface HeEngDaySpendAsker {
  userId?: string | null;
  projectId?: string | null;
}

/**
 * Общий потолок ENG: расход ВСЕХ us-проектов за скользящие последние 24 часа
 * до `now` против `capUsd`. НИКОГДА НЕ БРОСАЕТ. Чтение — не дольше
 * HE_ENG_DAY_SPEND_CHECK_TIMEOUT_MS (или `timeoutMs`, если он короче).
 * 'over' — ещё и алерт команде (один на окно на процесс; ждём его не дольше
 * HE_OPS_SEND_TIMEOUT_MS — одноразовый крон иначе вышел бы, не отправив).
 * 'unknown' HE_ENG_DAY_UNKNOWN_ALERT_AFTER раз подряд — алерт «потолок не
 * проверяется» (его не ждём: нажатие и так прождало срок чтения).
 * Сама проверка ничего не пишет в БД: что делать с 'over', решают вызывающие
 * (spendCeiling.ts, autoPipeline.ts, engPaidAccess.ts) — у этого порога без
 * durable-паузы.
 */
export async function checkHeEngDaySpendCeiling(
  db: SupabaseClient,
  args: {
    capUsd: number | null;
    serperUsdPer1000: number | null;
    now?: Date;
    timeoutMs?: number;
    asker?: HeEngDaySpendAsker;
  },
): Promise<HeEngDaySpendCheck> {
  const cap = validCap(args.capUsd);
  if (cap === null) return { verdict: { kind: 'off' }, spend: null, failure: null };
  const timeoutMs = Math.min(args.timeoutMs ?? HE_ENG_DAY_SPEND_CHECK_TIMEOUT_MS, HE_ENG_DAY_SPEND_CHECK_TIMEOUT_MS);
  const nowMs = (args.now ?? new Date()).getTime();
  const unknown = (failure: string, spend: HeClientSpend | null): HeEngDaySpendCheck => {
    noteHeEngDayUnknown({ failure, capUsd: cap, nowMs: Date.now() });
    return { verdict: { kind: 'unknown' }, spend, failure };
  };
  let spend: HeClientSpend;
  try {
    const outcome = await withTimeout(
      readHeEngProviderSpend(db, {
        fromIso: new Date(nowMs - HE_SPEND_DAY_WINDOW_MS).toISOString(),
        toIso: new Date(nowMs).toISOString(),
        serperUsdPer1000: args.serperUsdPer1000,
      }),
      timeoutMs,
    );
    if (outcome === 'timeout') return unknown(`check exceeded ${timeoutMs} ms`, null);
    spend = outcome;
  } catch (e) {
    return unknown(e instanceof Error ? e.message.slice(0, 200) : 'unknown', null);
  }
  const known = knownSpend(spend.knownUsd);
  if (known === null) return unknown('unreadable sum', spend);
  engDayUnknownStreak = 0;
  if (known < cap) return { verdict: { kind: 'under' }, spend, failure: null };
  await alertHeEngDaySpendCeiling({
    spend,
    capUsd: cap,
    serperPriced: args.serperUsdPer1000 !== null,
    asker: args.asker ?? null,
    nowMs: Date.now(),
  });
  return { verdict: { kind: 'over', spendUsd: known, capUsd: cap }, spend, failure: null };
}

/** Тот же воркер-идентификатор, что у остальных алертов ENG (opsAlert.ts). */
const HE_ENG_ALERT_WORKER_ID = 'hypothesis-engine · ENG';

type HeEngDayAlertKind = 'over' | 'unknown';

/**
 * Окна молчания алертов общего потолка в ЭТОМ процессе: до какого момента
 * (мс) не писать снова, своё у каждого вида. Объектом — снять окно может
 * только вызов, который его занял (тот же приём, что у окон opsAlert.ts).
 */
const engDayAlertHolds: Record<HeEngDayAlertKind, { until: number } | null> = { over: null, unknown: null };

/** «Неизвестно» общего потолка подряд в этом процессе (удачное чтение — 0). */
let engDayUnknownStreak = 0;

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Отправить алерт вида `kind`, если его окно (HE_OPS_CAPACITY_REPEAT_MS, 6 ч)
 * свободно. Решение «слать» синхронное (два почти одновременных вызова не
 * уйдут оба); окно держится, только если Telegram сообщение принял, иначе
 * снимается — и следующий вызов напишет снова. Процессы (воркер, крон, веб)
 * памяти не делят: не больше трёх сообщений вида за окно. Возвращает
 * обещание, которое ждёт отправку не дольше HE_OPS_SEND_TIMEOUT_MS (окно
 * занято — сразу). Не бросает.
 */
function sendHeEngDayAlertOnce(kind: HeEngDayAlertKind, nowMs: number, build: () => WorkerAlert): Promise<void> {
  try {
    const current = engDayAlertHolds[kind];
    if (current && nowMs < current.until) return Promise.resolve();
    const hold = { until: nowMs + HE_OPS_CAPACITY_REPEAT_MS };
    engDayAlertHolds[kind] = hold;
    const delivered = sendWorkerAlert(build()).catch(() => false);
    void delivered.then(
      (accepted) => {
        if (!accepted && engDayAlertHolds[kind] === hold) engDayAlertHolds[kind] = null;
      },
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HE_OPS_SEND_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    return Promise.race([delivered.then(() => undefined, () => undefined), late]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch {
    return Promise.resolve();
  }
}

/**
 * Алерт команде: общий потолок ENG достигнут. Дедуп и ожидание —
 * sendHeEngDayAlertOnce (вид 'over'). Не бросает.
 */
function alertHeEngDaySpendCeiling(args: {
  spend: HeClientSpend;
  capUsd: number;
  serperPriced: boolean;
  asker: HeEngDaySpendAsker | null;
  nowMs: number;
}): Promise<void> {
  return sendHeEngDayAlertOnce('over', args.nowMs, () => {
    const { spend } = args;
    // Нижняя граница — словами: число без оговорки команда прочтёт как точное.
    const caveats = [
      spend.unpricedCalls > 0 ? `без цены ${spend.unpricedCalls} обращ.` : null,
      args.serperPriced ? null : 'Serper не оценён (нет HE_US_SERPER_USD_PER_1000)',
      spend.lostRows > 0 ? `потеряно строк журнала ${spend.lostRows}` : null,
    ].filter(Boolean);
    const asker = args.asker;
    return {
      workerId: HE_ENG_ALERT_WORKER_ID,
      subject: 'общий суточный потолок расхода ENG достигнут — платные шаги ENG не ставятся',
      error:
        `известно ${usd(spend.knownUsd)} ≥ ${usd(args.capUsd)} за последние 24 ч: ` +
        `${spend.calls} обращ., проектов ${spend.projects}` +
        (caveats.length ? ` (нижняя граница: ${caveats.join(', ')})` : ''),
      context: {
        'порог': `${HE_US_ENG_DAY_SPEND_CAP_ENV}=${args.capUsd}`,
        'первым упёрся': asker
          ? [asker.projectId ? `проект ${asker.projectId}` : null, asker.userId ? `клиент ${asker.userId}` : null]
            .filter(Boolean)
            .join(', ') || null
          : null,
        'RU и VE2': 'не затронуты: порог считает и останавливает только рынок us',
        'клиент видит':
          'отказ платной кнопки кодом spend_day_limit с нейтральной фразой «Paid steps are paused on our side for a ' +
          'while… Try again in a few hours, or message Support.»; карточек паузы нет — паузы не пишутся',
        'сделать':
          'ничего, если всплеск честный: окно скользящее, и когда расход за последние 24 ч опустится ниже порога, ' +
          'кнопки кабинета снова пойдут сами. Durable-пауз порог не пишет: шаги автопилота, не поставленные в это ' +
          'время (строки «[he-spend] общий потолок ENG достигнут» в логе воркера и портала — какой шаг какого ' +
          'проекта), сами не повторятся — проект двигает «Launch» клиента на шаге 3 (карточка рынка зовёт к нему, ' +
          'когда ничего не идёт); ночной добор пропускает ночь без паузы (detail spend_held) и проверит снова ' +
          'следующей ночью. Всплеск не честный — разобрать, кто тратит (GET /api/tools/hypothesis-engine/projects/' +
          '<id>/cost). Поднять порог — эта переменная в .env прода и пересоздание portal и воркеров движка',
        'повтор': 'не чаще раза в 6 ч на процесс (воркер, крон, веб — каждый своё)',
      },
    };
  });
}

/**
 * Очередное «неизвестно» общего потолка: счёт подряд и, начиная с
 * HE_ENG_DAY_UNKNOWN_ALERT_AFTER, алерт «потолок не проверяется» (вид
 * 'unknown', раз в 6 ч на процесс). Отправку НЕ ждём: вызывающий уже
 * прождал срок чтения, а ответ «пускаем» от алерта не зависит. Не бросает.
 */
function noteHeEngDayUnknown(args: { failure: string; capUsd: number; nowMs: number }): void {
  engDayUnknownStreak += 1;
  if (engDayUnknownStreak < HE_ENG_DAY_UNKNOWN_ALERT_AFTER) return;
  const streak = engDayUnknownStreak;
  void sendHeEngDayAlertOnce('unknown', args.nowMs, () => ({
    workerId: HE_ENG_ALERT_WORKER_ID,
    subject: 'общий суточный потолок расхода ENG не проверяется — платные шаги ENG идут без него',
    error: `сумма расхода рынка us не прочитана ${streak} раз подряд: ${args.failure}`,
    context: {
      'порог': `${HE_US_ENG_DAY_SPEND_CAP_ENV}=${args.capUsd}`,
      'что значит':
        'проверка пускает платные шаги (fail-open), то есть стоп-крана против расхода общего с RU баланса ' +
        'Requesty/Serper сейчас нет',
      'сделать':
        'нет функции (текст называет миграцию) — применить 20261015_0011_he_us_spend_sum_24h; срок ' +
        `(${HE_ENG_DAY_SPEND_CHECK_TIMEOUT_MS} мс) — проверить индекс 20261015_0012_he_provider_usage_created_idx ` +
        '(EXPLAIN select * from public.he_us_provider_spend_sum(now() - interval \'24 hours\', now())) и нагрузку ' +
        'на основную БД; иной сбой — лог портала/воркера (client.eng.paid_access.degraded, [he-spend])',
      'повтор': 'не чаще раза в 6 ч на процесс (воркер, крон, веб — каждый своё); удачное чтение сбрасывает счёт',
    },
  })).catch(() => undefined);
}
