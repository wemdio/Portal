/**
 * Оценка размера пула 2GIS per сегмент — для блока «Остаток пула» дашборда
 * «2GIS + сигналы». pool_estimate = COUNT карточек датасета под рубрикатором
 * сегмента (тот же WHERE, что у pull-кандидатов: rubric_groups через
 * toTwoGisRubricGroups + has_website = true).
 *
 * Устойчивость к деградации датасета:
 *   - statement_timeout 15s в отдельной транзакции (SET LOCAL — не течёт
 *     в пул соединений): тяжёлый COUNT по 4M+ карточек не вешает запрос;
 *   - in-memory кэш на процесс: успех — 24ч (состав датасета меняется
 *     редко, импорт нового снапшота — событие дня), сбой — 10 минут,
 *     чтобы простой БД не превращал каждую загрузку дашборда в 15-секундное
 *     ожидание;
 *   - таймаут/недоступность → null (UI показывает «≈»/«—» с подсказкой),
 *     страница НЕ падает.
 */

import 'server-only';
import type { PoolClient } from 'pg';
import { twoGisDatasetConnect } from '@/lib/twoGisDataset';
import { buildTwoGisCountQuery } from '@/lib/twoGis/query';
import { toTwoGisRubricGroups } from '@/lib/twoGis/rubricGroups';
import type { GisSignalRubricGroup } from './config';

const POOL_ESTIMATE_TTL_MS = 24 * 60 * 60 * 1000;
const POOL_ESTIMATE_FAILURE_TTL_MS = 10 * 60 * 1000;
/** Тяжёлый COUNT по полному датасету не должен висеть дольше ~15s. */
export const POOL_ESTIMATE_STATEMENT_TIMEOUT_MS = 15_000;

interface CacheEntry {
  estimate: number | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Тестовый хук: сброс in-memory кэша между кейсами. */
export function resetPoolEstimateCache(): void {
  cache.clear();
}

/**
 * COUNT карточек 2GIS под рубрикатором сегмента (has_website=true).
 * null — датасет недоступен/таймаут/нет рубрикатора (не бросаем наружу).
 */
export async function estimateSegmentPool(
  segmentKey: string,
  rubricGroups: GisSignalRubricGroup[],
): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(segmentKey);
  if (cached && cached.expiresAt > now) return cached.estimate;

  let estimate: number | null = null;
  const rubric = toTwoGisRubricGroups(rubricGroups ?? []);
  if (rubric.length === 0) {
    // Без рубрикатора COUNT превратился бы в «весь датасет с сайтом» —
    // такую «оценку» показывать нельзя, она ничего не говорит о сегменте.
    cache.set(segmentKey, { estimate: null, expiresAt: now + POOL_ESTIMATE_FAILURE_TTL_MS });
    return null;
  }

  let client: PoolClient | null = null;
  try {
    client = await twoGisDatasetConnect();
    await client.query('BEGIN');
    // SET LOCAL действует до конца транзакции → не протекает в пул.
    await client.query(`SET LOCAL statement_timeout = ${POOL_ESTIMATE_STATEMENT_TIMEOUT_MS}`);
    const countQuery = buildTwoGisCountQuery({ rubricGroups: rubric, hasWebsite: true });
    const result = await client.query<{ count: string | number }>(countQuery.text, countQuery.params);
    const value = Number(result.rows[0]?.count);
    estimate = Number.isFinite(value) ? value : null;
    await client.query('COMMIT');
  } catch {
    estimate = null;
    if (client) await client.query('ROLLBACK').catch(() => undefined);
  } finally {
    client?.release();
  }

  cache.set(segmentKey, {
    estimate,
    expiresAt: now + (estimate === null ? POOL_ESTIMATE_FAILURE_TTL_MS : POOL_ESTIMATE_TTL_MS),
  });
  return estimate;
}

/** Оценки по всем сегментам параллельно (медленный COUNT одного не ждёт другие). */
export async function estimateSegmentPools(
  segments: Array<{ key: string; rubric_groups: GisSignalRubricGroup[] }>,
): Promise<Map<string, number | null>> {
  const entries = await Promise.all(
    segments.map(async (s) => [s.key, await estimateSegmentPool(s.key, s.rubric_groups)] as const),
  );
  return new Map(entries);
}
