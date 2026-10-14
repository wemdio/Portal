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
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { HE_SPEND_CHECK_TIMEOUT_MS, HE_SPEND_DAY_WINDOW_MS, readHeSpendCaps } from './spendCeiling';

/** Потолок клиента за всё время журнала, USD. Пусто/нет — выключен (дефолт). */
export const HE_US_CLIENT_SPEND_CAP_ENV = 'HE_US_CLIENT_SPEND_CAP_USD';
/** Потолок клиента за скользящие последние 24 часа, USD. Пусто/нет — выключен (дефолт). */
export const HE_US_CLIENT_DAY_SPEND_CAP_ENV = 'HE_US_CLIENT_DAY_SPEND_CAP_USD';

export interface HeClientSpendCaps {
  /** null — порог выключен. */
  totalCapUsd: number | null;
  /** null — порог выключен. */
  dayCapUsd: number | null;
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
    serperUsdPer1000: readHeSpendCaps(env).serperUsdPer1000,
    rejected,
  };
}

export function heClientSpendCeilingOn(caps: Pick<HeClientSpendCaps, 'totalCapUsd' | 'dayCapUsd'>): boolean {
  return caps.totalCapUsd !== null || caps.dayCapUsd !== null;
}

/* ─────────────── Чистое решение ─────────────── */

export type HeClientSpendCap = 'total' | 'day';

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

function sumNumber(row: Record<string, unknown>, field: string): number {
  const raw = row[field];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${CLIENT_SPEND_SUM_RPC}: field ${field} is not a non-negative number`);
  }
  return value;
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
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object') throw new Error(`${CLIENT_SPEND_SUM_RPC}: empty answer`);
  const tariff = filter.serperUsdPer1000;
  const priced = sumNumber(row, 'priced_usd');
  const credits = sumNumber(row, 'serper_credits');
  return {
    // Те же правила, что readHeProviderSpend: 9 знаков, Serper по тарифу.
    knownUsd: Number((priced + (tariff === null ? 0 : (credits * tariff) / 1000)).toFixed(9)),
    unpricedCalls:
      sumNumber(row, 'requesty_unpriced')
      + (tariff === null ? sumNumber(row, 'serper_calls') : sumNumber(row, 'serper_credits_unknown')),
    calls: sumNumber(row, 'calls'),
    lostRows: sumNumber(row, 'lost_rows'),
    skippedRows: sumNumber(row, 'skipped_rows'),
    projects: sumNumber(row, 'projects'),
  };
}

/* ─────────────── Проверка ─────────────── */

export interface HeClientSpendCheck {
  verdict: HeClientSpendVerdict;
  caps: HeClientSpendCaps;
  /** Расход за всё время (только при включённом пороге 'total'). */
  total: HeClientSpend | null;
  /** Расход за последние 24 часа (только при включённом пороге 'day'). */
  day: HeClientSpend | null;
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

/**
 * Проверить потолок клиента. НИКОГДА НЕ БРОСАЕТ и не ждёт дольше `timeoutMs`.
 * Запросы: выключен — ноль; включён — одна сумма на сервере на каждый
 * включённый порог, параллельно.
 */
export async function checkHeClientSpendCeiling(
  db: SupabaseClient,
  args: { userId: string; caps?: HeClientSpendCaps; now?: Date; timeoutMs?: number },
): Promise<HeClientSpendCheck> {
  const caps = args.caps ?? readHeClientSpendCaps();
  const base: HeClientSpendCheck = { verdict: { kind: 'off' }, caps, total: null, day: null, failure: null };
  if (!heClientSpendCeilingOn(caps)) return base;
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
      return { ...base, verdict: { kind: 'unknown', cap: unknownCap }, failure: `check exceeded ${timeoutMs} ms` };
    }
    const [total, day] = outcome;
    return {
      ...base,
      total,
      day,
      verdict: exceedsHeClientSpendCeiling({
        totalSpendUsd: total ? total.knownUsd : null,
        daySpendUsd: day ? day.knownUsd : null,
        totalCapUsd: caps.totalCapUsd,
        dayCapUsd: caps.dayCapUsd,
      }),
    };
  } catch (e) {
    return {
      ...base,
      verdict: { kind: 'unknown', cap: unknownCap },
      failure: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
    };
  }
}

/**
 * То же по id проекта — для путей без пользователя в руках (ворота дочейна
 * воркера, реконсилер, ночной добор). Проект не 'us' — 'off' (потолок ENG не
 * для него); владельца нет или прочитать не удалось — 'unknown' (пускаем).
 */
export async function checkHeClientSpendCeilingForProject(
  db: SupabaseClient,
  args: { projectId: string; caps?: HeClientSpendCaps; now?: Date; timeoutMs?: number },
): Promise<HeClientSpendCheck & { userId: string | null }> {
  const caps = args.caps ?? readHeClientSpendCaps();
  if (!heClientSpendCeilingOn(caps)) {
    return { verdict: { kind: 'off' }, caps, total: null, day: null, failure: null, userId: null };
  }
  const unknownCap: HeClientSpendCap = caps.totalCapUsd !== null ? 'total' : 'day';
  try {
    const { data, error } = await db
      .from('he_projects')
      .select('created_by, market')
      .eq('id', args.projectId)
      .maybeSingle();
    const row = (data ?? null) as { created_by?: unknown; market?: unknown } | null;
    if (error || !row) {
      return {
        verdict: { kind: 'unknown', cap: unknownCap },
        caps,
        total: null,
        day: null,
        failure: error ? `he_projects read: ${error.code ?? 'error'}` : 'project not found',
        userId: null,
      };
    }
    if (row.market !== 'us') return { verdict: { kind: 'off' }, caps, total: null, day: null, failure: null, userId: null };
    if (typeof row.created_by !== 'string' || !row.created_by) {
      return { verdict: { kind: 'unknown', cap: unknownCap }, caps, total: null, day: null, failure: 'project has no owner', userId: null };
    }
    const check = await checkHeClientSpendCeiling(db, { userId: row.created_by, caps, now: args.now, timeoutMs: args.timeoutMs });
    return { ...check, userId: row.created_by };
  } catch (e) {
    return {
      verdict: { kind: 'unknown', cap: unknownCap },
      caps,
      total: null,
      day: null,
      failure: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
      userId: null,
    };
  }
}
