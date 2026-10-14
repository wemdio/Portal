/**
 * Сколько обычно длятся два ожидания ENG-клиента — для фраз мастера кабинета
 * «Research usually takes about N minutes» (шаг 1) и «This usually takes about
 * N hours» (шаг 3). Числа — МЕДИАНЫ по недавним us-проектам, прочитанные из БД
 * во время работы, а не константы: обещание «обычно» правдиво ровно настолько,
 * насколько правдива история, из которой оно посчитано.
 *
 *  - research — минуты от постановки site_profile до конца clustering по
 *    последним HE_ENG_ESTIMATE_SAMPLES проектам, у которых research закончился
 *    за HE_ENG_ESTIMATE_WINDOW_DAYS дней. Начало — ПОСЛЕДНИЙ site_profile до
 *    этого конца: повтор research («Try again», повтор с удалением) начинается
 *    заново с site_profile, и мерить надо прогон, который дошёл;
 *  - prepare — часы от ПЕРВОЙ цепочки писем рынка (chain-джоба, payload
 *    vertical_id) до его ПЕРВОГО шаблона (итоговых писем) по последним
 *    HE_ENG_ESTIMATE_SAMPLES рынкам за то же окно. Это путь, который проходит
 *    «Launch»: письма → сборка → проверка → итоговые письма; сам запуск
 *    кампании после шаблона — минуты.
 *
 * Сэмплов меньше HE_ENG_ESTIMATE_MIN_SAMPLES или чтение упало — null, и экран
 * фразу с числом не печатает вовсе (никакого «примерно» из воздуха). Только
 * чтение, ничего не пишет.
 *
 * Кэш в памяти процесса на HE_ENG_ESTIMATE_CACHE_MS: деталку проекта кабинет
 * опрашивает каждые 4 секунды, а медиана за 30 дней за 15 минут не меняется.
 * Сбой кэшируется на минуту — чтобы опрос не долбил БД, пока она лежит.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logWarn } from '@/lib/loggerServer';

export const HE_ENG_ESTIMATE_WINDOW_DAYS = 30;
export const HE_ENG_ESTIMATE_SAMPLES = 20;
export const HE_ENG_ESTIMATE_MIN_SAMPLES = 3;
export const HE_ENG_ESTIMATE_CACHE_MS = 15 * 60_000;
const ESTIMATE_FAILURE_CACHE_MS = 60_000;

/** Сколько недавних us-проектов читается за раз (граница выборки, а не сэмплов). */
const RECENT_PROJECTS_LIMIT = 100;
/** Размер куска для `in (...)`: длина URL запроса PostgREST. */
const IN_CHUNK = 100;
/** Граница каждой выборки джоб и шаблонов. */
const ROWS_LIMIT = 2000;

export interface HeEngTypicalDurations {
  /** Медиана минут research, кратно 5; null — не измерено. */
  researchMinutes: number | null;
  /** Медиана часов подготовки рынка до итоговых писем, кратно 0,5; null — не измерено. */
  prepareHours: number | null;
}

type Row = Record<string, unknown>;

const NONE: HeEngTypicalDurations = { researchMinutes: null, prepareHours: null };

let cached: { until: number; value: HeEngTypicalDurations } | null = null;
let inflight: Promise<HeEngTypicalDurations> | null = null;

function ms(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function payloadVerticalId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  return str((payload as Row).vertical_id);
}

/** Медиана; меньше минимума сэмплов — null. */
export function heEngMedian(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length < HE_ENG_ESTIMATE_MIN_SAMPLES) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function readRecentUsProjectIds(db: SupabaseClient, cutoffIso: string): Promise<string[]> {
  const { data, error } = await db
    .from('he_projects')
    .select('id')
    .eq('market', 'us')
    .gte('updated_at', cutoffIso)
    .order('updated_at', { ascending: false })
    .limit(RECENT_PROJECTS_LIMIT);
  if (error) throw new Error(`he_projects recent us read: ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => str(r.id)).filter(Boolean);
}

async function measureResearchMinutes(
  db: SupabaseClient,
  projectIds: readonly string[],
  cutoffIso: string,
): Promise<number | null> {
  if (projectIds.length === 0) return null;
  const { data: doneRows, error: doneErr } = await db
    .from('he_jobs')
    .select('project_id, finished_at')
    .in('project_id', projectIds as string[])
    .eq('stage', 'clustering')
    .eq('status', 'done')
    .gte('finished_at', cutoffIso)
    .limit(ROWS_LIMIT);
  if (doneErr) throw new Error(`he_jobs clustering read: ${doneErr.message}`);

  /** project → конец последнего законченного research. */
  const finishedAt = new Map<string, number>();
  for (const row of (doneRows ?? []) as Row[]) {
    const projectId = str(row.project_id);
    const t = ms(row.finished_at);
    if (!projectId || t === null) continue;
    if (t > (finishedAt.get(projectId) ?? Number.NEGATIVE_INFINITY)) finishedAt.set(projectId, t);
  }
  const latest = [...finishedAt.entries()].sort((a, b) => b[1] - a[1]).slice(0, HE_ENG_ESTIMATE_SAMPLES);
  if (latest.length < HE_ENG_ESTIMATE_MIN_SAMPLES) return null;

  const { data: startRows, error: startErr } = await db
    .from('he_jobs')
    .select('project_id, created_at')
    .in('project_id', latest.map(([projectId]) => projectId))
    .eq('stage', 'site_profile')
    .limit(ROWS_LIMIT);
  if (startErr) throw new Error(`he_jobs site_profile read: ${startErr.message}`);

  const startsByProject = new Map<string, number[]>();
  for (const row of (startRows ?? []) as Row[]) {
    const projectId = str(row.project_id);
    const t = ms(row.created_at);
    if (!projectId || t === null) continue;
    const list = startsByProject.get(projectId) ?? [];
    list.push(t);
    startsByProject.set(projectId, list);
  }

  const minutes: number[] = [];
  for (const [projectId, end] of latest) {
    const starts = (startsByProject.get(projectId) ?? []).filter((t) => t <= end);
    if (starts.length === 0) continue;
    minutes.push((end - Math.max(...starts)) / 60_000);
  }
  const median = heEngMedian(minutes);
  return median === null ? null : Math.max(5, Math.round(median / 5) * 5);
}

async function measurePrepareHours(
  db: SupabaseClient,
  projectIds: readonly string[],
  cutoffIso: string,
): Promise<number | null> {
  if (projectIds.length === 0) return null;
  const { data: chainRows, error: chainErr } = await db
    .from('he_jobs')
    .select('payload, created_at')
    .in('project_id', projectIds as string[])
    .eq('stage', 'chain')
    .gte('created_at', cutoffIso)
    .limit(ROWS_LIMIT);
  if (chainErr) throw new Error(`he_jobs chain read: ${chainErr.message}`);

  /** vertical → постановка его первой цепочки писем. */
  const chainStart = new Map<string, number>();
  for (const row of (chainRows ?? []) as Row[]) {
    const verticalId = payloadVerticalId(row.payload);
    const t = ms(row.created_at);
    if (!verticalId || t === null) continue;
    if (t < (chainStart.get(verticalId) ?? Number.POSITIVE_INFINITY)) chainStart.set(verticalId, t);
  }
  if (chainStart.size < HE_ENG_ESTIMATE_MIN_SAMPLES) return null;

  /** vertical → его первый шаблон не раньше первой цепочки. */
  const templateAt = new Map<string, number>();
  for (const part of chunks([...chainStart.keys()], IN_CHUNK)) {
    const { data, error } = await db
      .from('he_templates')
      .select('vertical_id, created_at')
      .in('vertical_id', part)
      .gte('created_at', cutoffIso)
      .limit(ROWS_LIMIT);
    if (error) throw new Error(`he_templates read: ${error.message}`);
    for (const row of (data ?? []) as Row[]) {
      const verticalId = str(row.vertical_id);
      const t = ms(row.created_at);
      const start = chainStart.get(verticalId);
      if (!verticalId || t === null || start === undefined || t < start) continue;
      if (t < (templateAt.get(verticalId) ?? Number.POSITIVE_INFINITY)) templateAt.set(verticalId, t);
    }
  }

  const hours = [...templateAt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, HE_ENG_ESTIMATE_SAMPLES)
    .map(([verticalId, end]) => (end - (chainStart.get(verticalId) as number)) / 3_600_000);
  const median = heEngMedian(hours);
  return median === null ? null : Math.max(0.5, Math.round(median * 2) / 2);
}

function reason(settled: PromiseSettledResult<unknown>): string | null {
  if (settled.status === 'fulfilled') return null;
  return settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
}

async function measure(db: SupabaseClient, now: Date): Promise<{ value: HeEngTypicalDurations; failed: boolean }> {
  const cutoffIso = new Date(now.getTime() - HE_ENG_ESTIMATE_WINDOW_DAYS * 24 * 3_600_000).toISOString();
  let projectIds: string[];
  try {
    projectIds = await readRecentUsProjectIds(db, cutoffIso);
  } catch (e) {
    void logWarn('he.eng.estimates.read_failed', e instanceof Error ? e.message : String(e));
    return { value: NONE, failed: true };
  }
  const [research, prepare] = await Promise.allSettled([
    measureResearchMinutes(db, projectIds, cutoffIso),
    measurePrepareHours(db, projectIds, cutoffIso),
  ]);
  const failures = [reason(research), reason(prepare)].filter((r): r is string => r !== null);
  // Строка лога не чаще раза в минуту на процесс: сбой кэшируется на
  // ESTIMATE_FAILURE_CACHE_MS, и до его конца сюда никто не заходит.
  if (failures.length > 0) void logWarn('he.eng.estimates.read_failed', failures.join('; '));
  return {
    value: {
      researchMinutes: research.status === 'fulfilled' ? research.value : null,
      prepareHours: prepare.status === 'fulfilled' ? prepare.value : null,
    },
    failed: research.status === 'rejected' || prepare.status === 'rejected',
  };
}

/**
 * Типичная длительность research и подготовки рынка (см. шапку). Никогда не
 * бросает: любой сбой — null в соответствующем поле. Параллельные вызовы при
 * пустом кэше ждут одно чтение.
 */
export async function readHeEngTypicalDurations(
  db: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<HeEngTypicalDurations> {
  const now = opts.now ?? new Date();
  if (cached && cached.until > now.getTime()) return cached.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { value, failed } = await measure(db, now);
      cached = { until: now.getTime() + (failed ? ESTIMATE_FAILURE_CACHE_MS : HE_ENG_ESTIMATE_CACHE_MS), value };
      return value;
    } catch {
      cached = { until: now.getTime() + ESTIMATE_FAILURE_CACHE_MS, value: NONE };
      return NONE;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
