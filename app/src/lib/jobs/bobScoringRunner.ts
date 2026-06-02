/**
 * Один tick фонового BoB scorer'а.
 *
 * Логика:
 *   1. Читаем background_scorer_state — если disabled, выходим.
 *   2. Берём batch_size BoB-строк с offset, фильтр revenue ≥ revenue_from
 *      (revenue_from = 0 → без фильтра по выручке, берём все сайты).
 *   3. Отбрасываем те, чей domain УЖЕ в mailganer_domain_scores (не зачем
 *      повторно скорить).
 *   4. Для оставшихся параллельно (concurrency=5) дёргаем Mailganer +
 *      сохраняем в кэш с полной BoB-метадатой (name, area, industries, INN).
 *   5. Обновляем state: offset, counters, last_tick_at.
 *
 * Resilience: если воркер убили SIGTERM посреди batch'а, offset обновится
 * только в конце tick'а. Это значит при перезапуске мы повторно обработаем
 * незавершённый batch — но это **безвредно**, потому что getOrFetchScore
 * сначала проверяет кэш и для уже сохранённых доменов делает no-op.
 *
 * Тестируемость: вся работа с БД через supabaseAdmin client (можно подсунуть
 * mock). Mailganer-вызовы — через getOrFetchScore (тоже mock'абельный).
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { getOrFetchScore, normalizeDomain } from './mailganerScoreCache';
import {
  cleanBobName,
  extractFirstWebsite,
  extractCityFromAddress,
} from './baseOfBasesSource';

export interface BackgroundScorerState {
  id: number;
  enabled: boolean;
  current_offset: number;
  domains_scored_total: number;
  domains_active_total: number;
  last_tick_at: string | null;
  last_tick_batch_size: number | null;
  last_error: string | null;
  last_error_at: string | null;
  batch_size: number;
  sleep_between_batches_ms: number;
  revenue_from: number;
  /** Параллельных запросов к Mailganer = фактический RPS-потолок (из конфига). */
  concurrency?: number;
}

export interface TickResult {
  /** Прерван из-за enabled=false / закончились данные / ошибки */
  status: 'tick_done' | 'disabled' | 'exhausted' | 'error';
  domainsScanned: number;
  domainsScored: number;
  domainsActive: number;
  cacheHits: number;
  errorMessage?: string;
}

interface ScoreEndpointConfig {
  url: string;
  apiKey: string;
  authScheme: string;
  timeoutMs: number;
}

export async function loadScorerState(): Promise<BackgroundScorerState | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('background_scorer_state')
    .select('*')
    .eq('id', 1)
    .single();
  if (error || !data) return null;
  return data as BackgroundScorerState;
}

/**
 * Один tick. Возвращает summary для логирования. Не бросает — все ошибки
 * ловятся внутри и записываются в state.last_error.
 */
export async function runBobScoringTick(
  endpoint: ScoreEndpointConfig,
): Promise<TickResult> {
  if (!supabaseAdmin) {
    return { status: 'error', domainsScanned: 0, domainsScored: 0, domainsActive: 0, cacheHits: 0, errorMessage: 'supabaseAdmin not configured' };
  }

  const state = await loadScorerState();
  if (!state) {
    return { status: 'error', domainsScanned: 0, domainsScored: 0, domainsActive: 0, cacheHits: 0, errorMessage: 'state not loaded' };
  }

  if (!state.enabled) {
    return { status: 'disabled', domainsScanned: 0, domainsScored: 0, domainsActive: 0, cacheHits: 0 };
  }

  // 1. Берём batch BoB-строк.
  // revenue_from = 0 трактуем как «без фильтра по выручке»: скорим ВСЕ компании
  // с сайтом (включая те, у кого оборота нет в данных ФНС). Любое значение >0 —
  // это минимальный порог выручки. NULL в RPC = условие отключено.
  const { rows, error: searchErr } = await searchRows(
    {
      revenueFrom: state.revenue_from > 0 ? state.revenue_from : null,
      hasWebsite: true,
      includeIp: false,
    },
    state.batch_size,
    state.current_offset,
  );

  if (searchErr) {
    await markError(searchErr);
    return { status: 'error', domainsScanned: 0, domainsScored: 0, domainsActive: 0, cacheHits: 0, errorMessage: searchErr };
  }

  if (!rows || rows.length === 0) {
    // Закончились данные — оффсет вышел за пределы. Сигнализируем «обошли всё»
    // и фактически останавливаем работу (UI покажет 100%).
    return { status: 'exhausted', domainsScanned: 0, domainsScored: 0, domainsActive: 0, cacheHits: 0 };
  }

  // 2. Параллельно скорим, считаем counters.
  let scoredCount = 0;
  let activeCount = 0;
  let cacheHitCount = 0;

  // RPS-потолок берём из конфига (background_scorer_state.concurrency).
  // Фоллбэк 5 — на случай если миграция ещё не применена и поля нет в строке.
  const concurrency = state.concurrency ?? 5;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const raw = rows[i] as { website?: string | null; name?: string | null; inn?: string | null; address?: string | null; employees_count?: number | null; activity_type?: string | null; okved_name?: string | null };
      const siteUrl = extractFirstWebsite(raw.website);
      if (!siteUrl) continue;
      const domain = normalizeDomain(siteUrl.replace(/^https?:\/\//, ''));
      if (!domain) continue;

      // getOrFetchScore сам проверит кэш и при miss дёрнет Mailganer +
      // сохранит результат. Мы дополнительно UPDATE'аем BoB-метаданные
      // (нет в кэш-логике mailganerScoreCache, потому что cron не знает
      // BoB-инфо). Если строка уже была в кэше — UPDATE добавит BoB-поля
      // без обнуления существующих.
      try {
        const before = await checkDomainInCache(domain);
        if (before) {
          cacheHitCount++;
          // Уже в кэше — но возможно без BoB-метаданных (был scored через cron).
          // Добавим их.
          await enrichCachedRowWithBob(domain, raw);
          continue;
        }
        const result = await getOrFetchScore(domain, endpoint, 'background');
        if (!result.ok || result.score === null) {
          // Mailganer error — не сохраняем. Следующий tick попробует снова.
          continue;
        }
        scoredCount++;
        if (result.score > 0) activeCount++;

        // Записываем BoB-метаданные отдельным UPDATE (getOrFetchScore только
        // сохраняет score/spf/rating/raw).
        await enrichCachedRowWithBob(domain, raw);
      } catch {
        // Skip единичные ошибки — продолжаем batch
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  // 3. Обновляем state. ВАЖНО: increment counters атомарно (используем raw SQL
  // через RPC или просто UPDATE+RETURNING). Здесь делаем простой UPDATE —
  // если будет race condition (другой worker одновременно), один из апдейтов
  // может потеряться. Но у нас один worker, не страшно.
  await supabaseAdmin
    .from('background_scorer_state')
    .update({
      current_offset: state.current_offset + rows.length,
      domains_scored_total: state.domains_scored_total + scoredCount,
      domains_active_total: state.domains_active_total + activeCount,
      last_tick_at: new Date().toISOString(),
      last_tick_batch_size: rows.length,
      last_error: null,
      last_error_at: null,
    })
    .eq('id', 1);

  return {
    status: 'tick_done',
    domainsScanned: rows.length,
    domainsScored: scoredCount,
    domainsActive: activeCount,
    cacheHits: cacheHitCount,
  };
}

async function checkDomainInCache(domain: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data } = await supabaseAdmin
    .from('mailganer_domain_scores')
    .select('domain')
    .eq('domain', domain)
    .maybeSingle();
  return Boolean(data);
}

interface BobRowMeta {
  name?: string | null;
  inn?: string | null;
  address?: string | null;
  employees_count?: number | null;
  activity_type?: string | null;
  okved_name?: string | null;
}

async function enrichCachedRowWithBob(domain: string, raw: BobRowMeta): Promise<void> {
  if (!supabaseAdmin) return;
  const name = cleanBobName(raw.name ?? '');
  const area = extractCityFromAddress(raw.address);
  const industries = [raw.activity_type, raw.okved_name].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  await supabaseAdmin
    .from('mailganer_domain_scores')
    .update({
      company_name: name || null,
      bob_inn: raw.inn ?? null,
      area: area,
      employees_count: typeof raw.employees_count === 'number' ? raw.employees_count : null,
      industries: industries.length > 0 ? industries : null,
    })
    .eq('domain', domain);
}

async function markError(message: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('background_scorer_state')
    .update({
      last_error: message.slice(0, 500),
      last_error_at: new Date().toISOString(),
    })
    .eq('id', 1);
}
