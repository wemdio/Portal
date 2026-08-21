/**
 * Нормализация входящего списка ИНН + батчевый вызов inn_enrich_fetch.
 * Общий код match-роута и воркера: клиенту не верим, дедуп на сервере.
 */

import { chunkArray, dedupeInns, normalizeInn, RPC_BATCH_SIZE } from './inn';
import type { EnrichRow } from './fields';

export function collectValidInns(raw: unknown[]): { unique: string[]; invalidCount: number } {
  const valid: string[] = [];
  let invalidCount = 0;
  for (const value of raw) {
    const inn = normalizeInn(value);
    if (inn === null) {
      if (value !== null && value !== undefined && String(value).trim() !== '') invalidCount += 1;
    } else {
      valid.push(inn);
    }
  }
  return { unique: dedupeInns(valid), invalidCount };
}

export type InnEnrichRpc = (
  batch: string[],
) => PromiseLike<{ data: EnrichRow[] | null; error: { message: string } | null }>;

/**
 * Тянет записи по уникальным ИНН чанками RPC_BATCH_SIZE.
 * onProgress(done, total) — после каждого успешного батча (для heartbeat джобы).
 * Падение любого батча пробрасывается — частичный результат врал бы статистике.
 */
export async function fetchMatchRows(
  uniqueInns: string[],
  rpc: InnEnrichRpc,
  onProgress?: (done: number, total: number) => void | Promise<void>,
): Promise<EnrichRow[]> {
  const rows: EnrichRow[] = [];
  let done = 0;
  for (const batch of chunkArray(uniqueInns, RPC_BATCH_SIZE)) {
    const { data, error } = await rpc(batch);
    if (error) throw new Error(error.message);
    if (Array.isArray(data)) rows.push(...data);
    done += batch.length;
    await onProgress?.(done, uniqueInns.length);
  }
  return rows;
}

export function rowsToMatchMap(rows: EnrichRow[]): Map<string, EnrichRow> {
  const map = new Map<string, EnrichRow>();
  for (const row of rows) {
    const inn = typeof row.inn === 'string' ? row.inn : normalizeInn(row.inn);
    if (inn) map.set(inn, row);
  }
  return map;
}
