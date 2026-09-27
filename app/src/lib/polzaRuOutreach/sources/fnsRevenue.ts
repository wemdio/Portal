/**
 * Выручка компании за два года из открытой бухотчётности ФНС (bo.nalog.gov.ru).
 *
 * Проверено 25.09.2026, без ключа:
 *   GET /advanced-search/organizations/search?query=<ИНН>&page=0 → content[].id, inn (с <strong>)
 *   GET /nbo/organizations/<id>/bfo/ → отчёты; typeCorrections[0].correction.financialResult
 *       .current2110 / .previous2110 — выручка отчётного и прошлого года, тыс. ₽.
 * Ответы кэшируются в polza_ru_fns_revenue на 30 дней (и пустые тоже).
 * Запросы идут по одному с паузой — сервис государственный, не нагружаем.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Signal } from '../types';

const BASE = 'https://bo.nalog.gov.ru';
const TIMEOUT_MS = 8_000;
const PAUSE_MS = 1_000;
const CACHE_DAYS = 30;
export const MIN_REVENUE_GROWTH = 0.2;

export interface RevenueFact {
  inn: string;
  orgId: number | null;
  year: number | null;
  revenue: number | null;
  revenuePrev: number | null;
}

let queue: Promise<void> = Promise.resolve();

/** Последовательные запросы с паузой между ними, даже при параллельном конвейере. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => new Promise((r) => setTimeout(r, PAUSE_MS)),
    () => new Promise((r) => setTimeout(r, PAUSE_MS)),
  );
  return run;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Polza Portal)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ФНС ответила HTTP ${res.status}`);
  return res.json();
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchFromFns(inn: string): Promise<RevenueFact> {
  const found = (await throttled(() => getJson(`/advanced-search/organizations/search?query=${inn}&page=0`))) as {
    content?: Array<{ id?: number; inn?: string }>;
  };
  const org = (found.content ?? []).find((c) => String(c.inn ?? '').replace(/<[^>]+>/g, '') === inn);
  if (!org?.id) return { inn, orgId: null, year: null, revenue: null, revenuePrev: null };

  const reports = (await throttled(() => getJson(`/nbo/organizations/${org.id}/bfo/`))) as Array<{
    period?: string | number;
    typeCorrections?: Array<{ correction?: { financialResult?: { current2110?: unknown; previous2110?: unknown } } }>;
  }>;
  let best: RevenueFact = { inn, orgId: org.id, year: null, revenue: null, revenuePrev: null };
  for (const r of Array.isArray(reports) ? reports : []) {
    const year = num(r.period);
    const fin = r.typeCorrections?.[0]?.correction?.financialResult;
    const current = num(fin?.current2110);
    if (year === null || current === null) continue;
    if (best.year === null || year > best.year) {
      const prev = num(fin?.previous2110);
      best = { inn, orgId: org.id, year, revenue: current * 1000, revenuePrev: prev === null ? null : prev * 1000 };
    }
  }
  return best;
}

export async function fetchRevenue(db: SupabaseClient, inn: string): Promise<RevenueFact> {
  const since = new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString();
  const { data: cached } = await db
    .from('polza_ru_fns_revenue')
    .select('inn,bfo_org_id,report_year,revenue,revenue_prev')
    .eq('inn', inn)
    .gte('fetched_at', since)
    .maybeSingle();
  if (cached) {
    return {
      inn,
      orgId: num(cached.bfo_org_id),
      year: num(cached.report_year),
      revenue: num(cached.revenue),
      revenuePrev: num(cached.revenue_prev),
    };
  }
  const fact = await fetchFromFns(inn);
  await db.from('polza_ru_fns_revenue').upsert({
    inn,
    bfo_org_id: fact.orgId,
    report_year: fact.year,
    revenue: fact.revenue,
    revenue_prev: fact.revenuePrev,
    fetched_at: new Date().toISOString(),
  });
  return fact;
}

/**
 * Повод «рост выручки». Дата — 31 марта следующего года: к ней отчётность
 * становится публичной. Цифры роста — только в заголовке для таблицы; в
 * письмо они не идут (QA режет неподтверждённые числа).
 */
export function revenueGrowthSignal(f: RevenueFact): Signal | null {
  if (!f.year || !f.revenue || !f.revenuePrev || f.revenuePrev <= 0) return null;
  const growth = f.revenue / f.revenuePrev - 1;
  if (growth < MIN_REVENUE_GROWTH) return null;
  const pct = Math.round(growth * 100);
  return {
    type: 'revenue_growth',
    source: 'revenue_growth',
    title: `Выручка за ${f.year} выросла на ${pct}% к ${f.year - 1}`,
    date: `${f.year + 1}-03-31`,
    url: f.orgId ? `${BASE}/organizations-card/${f.orgId}` : null,
    quote: null,
    level: 'B',
    meta: { growth_pct: pct, revenue: f.revenue, revenue_prev: f.revenuePrev, year: f.year },
  };
}
