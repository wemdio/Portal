/**
 * Per-domain кэш Mailganer score'ов (вечный).
 *
 * Раньше: каждый cron-прогон → Mailganer запрос для всех 11k+ employer'ов
 * (даже если домен уже скорили вчера). ~37 минут из 2.5 часов прогона.
 *
 * Теперь: getOrFetchScore() сначала смотрит в БД. Если домен скорили
 * когда-либо в прошлом — берёт оттуда мгновенно. Если нет — дёргает
 * Mailganer + сохраняет в кэш для следующих прогонов.
 *
 * Никакого TTL — score деливерабилитет почти не меняется (SPF/MX стабильны
 * годами). Через 2-3 недели работы большинство известных доменов будут в
 * кэше → cron автоматически ускорится.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchScoreForDomain, type FetchScoreInput, type FetchScoreResult } from './clientEndpointClient';

interface CachedRow {
  domain: string;
  score: number | null;
  spf: string | null;
  rating: string | null;
  raw: Record<string, unknown> | null;
}

export interface MailganerCacheStats {
  hits: number;
  misses: number;
  errors: number;
}

/**
 * Получить score для домена. Сначала смотрит в БД-кэш, потом дёргает API.
 *
 * Возвращает FetchScoreResult в том же формате что fetchScoreForDomain,
 * чтобы быть drop-in заменой для существующего кода в enrichEmployers.
 *
 * Если БД-запрос упал — fallback на прямой fetchScoreForDomain (надёжность
 * пайплайна важнее эффективности кэша).
 */
export async function getOrFetchScore(
  domain: string,
  endpoint: Omit<FetchScoreInput, 'domain'>,
  source: 'cron' | 'background' | 'manual' = 'cron',
  stats?: MailganerCacheStats,
): Promise<FetchScoreResult> {
  if (!supabaseAdmin) {
    // Без админ-клиента к Supabase — просто проходим через прямой fetch.
    return fetchScoreForDomain({ ...endpoint, domain });
  }

  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return { score: null, spf: null, raw: null, ok: false, error: 'invalid_domain' };
  }

  // 1. Lookup в кэше.
  try {
    const { data, error } = await supabaseAdmin
      .from('mailganer_domain_scores')
      .select('domain, score, spf, rating, raw')
      .eq('domain', normalized)
      .maybeSingle();

    if (!error && data) {
      const row = data as CachedRow;
      if (stats) stats.hits += 1;
      return {
        score: row.score,
        spf: row.spf,
        raw: row.raw,
        ok: true,
      };
    }
    // error без data — продолжаем к API (мог быть RLS-сбой).
  } catch {
    // ignore — fallback
  }

  // 2. Cache miss — дёргаем Mailganer.
  if (stats) stats.misses += 1;
  const fresh = await fetchScoreForDomain({ ...endpoint, domain: normalized });

  // 3. Если получили валидный ответ → сохраняем в кэш для следующих прогонов.
  //    Ошибки (ok=false) НЕ кэшируем — это transient (timeout, network, 401),
  //    в следующий раз может ответить нормально.
  if (fresh.ok) {
    try {
      const ratingFromRaw =
        fresh.raw && typeof fresh.raw === 'object' && 'rating' in fresh.raw
          ? String((fresh.raw as Record<string, unknown>).rating ?? '')
          : null;

      await supabaseAdmin
        .from('mailganer_domain_scores')
        .upsert(
          {
            domain: normalized,
            score: fresh.score,
            spf: fresh.spf,
            rating: ratingFromRaw,
            raw: fresh.raw,
            source,
            scored_at: new Date().toISOString(),
          },
          { onConflict: 'domain' },
        );
    } catch {
      // upsert упал — не фейлим прогон, score уже получен корректно
      if (stats) stats.errors += 1;
    }
  }

  return fresh;
}

/**
 * Батч-lookup кэша для уже нормализованных доменов. Один SELECT на чанк
 * вместо запроса на каждый домен — при drain'е файлов в миллионы доменов
 * одиночные lookup'ы давали ~половину всех транзакций main-БД.
 *
 * Возвращает Map domain → результат только для найденных в кэше; промахи
 * докручиваются обычным getOrFetchScore (он же пишет в кэш).
 */
export async function getCachedScores(domains: string[]): Promise<Map<string, FetchScoreResult>> {
  const out = new Map<string, FetchScoreResult>();
  if (!supabaseAdmin || domains.length === 0) return out;
  const CHUNK = 100; // домены уходят в URL фильтра in() — держим запрос компактным
  for (let i = 0; i < domains.length; i += CHUNK) {
    try {
      const { data, error } = await supabaseAdmin
        .from('mailganer_domain_scores')
        .select('domain, score, spf, rating, raw')
        .in('domain', domains.slice(i, i + CHUNK));
      if (error || !data) continue;
      for (const row of data as CachedRow[]) {
        out.set(row.domain, { score: row.score, spf: row.spf, raw: row.raw, ok: true });
      }
    } catch {
      // чанк упал — его домены просто пойдут одиночным путём
    }
  }
  return out;
}

/**
 * Нормализация домена: lowercase + без www. Используется как PK в кэше.
 * Гарантирует что 'WWW.ya.ru', 'ya.ru', 'YA.RU' будут одной записью.
 */
export function normalizeDomain(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const noWww = trimmed.startsWith('www.') ? trimmed.slice(4) : trimmed;
  // Грубая sanity-проверка: должно содержать точку и хотя бы 3 символа.
  if (noWww.length < 3 || !noWww.includes('.')) return null;
  return noWww;
}

/** Создать пустой статистический счётчик для прогона. */
export function emptyCacheStats(): MailganerCacheStats {
  return { hits: 0, misses: 0, errors: 0 };
}
