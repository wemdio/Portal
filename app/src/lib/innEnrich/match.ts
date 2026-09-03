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

export interface FetchMatchRowsOptions {
  /**
   * С какого места в списке ИНН продолжать (возобновление после перезапуска).
   *
   * Записи по индексам меньше startIndex функция НЕ возвращает — их обязан
   * восстановить вызывающий из своего хранилища отрезков. Сама
   * последовательность батчей от этого не меняется: она целиком определяется
   * порядком uniqueInns, а он у воркера выводится из порядка строк файла
   * (extractInns → dedupeInns, Set хранит порядок первого вхождения). То есть
   * позиционный курсор здесь законен — он не зависит ни от выборки без
   * сортировки, ни от обхода множества с непредсказуемым порядком.
   */
  startIndex?: number;
  /** (done, total) после каждого успешного батча (для отметки прогресса джобы). */
  onProgress?: (done: number, total: number) => void | Promise<void>;
  /**
   * Через сколько ИНН сбрасывать накопленный отрезок наружу. Работает только
   * вместе с onSegment; 0 или отсутствие любого из двух — не сбрасывать вовсе.
   */
  segmentSize?: number;
  /**
   * Сохранить накопленный отрезок результатов и сдвинуть курсор на done.
   *
   * Возврат false — «не сохранилось»: буфер НЕ очищается и курсор не двигается,
   * отрезок уедет в следующую попытку вместе с новыми строками. Иначе строки
   * неудавшегося отрезка пропали бы из хранилища, а курсор их бы перепрыгнул —
   * то есть тихая потеря части результата.
   *
   * Последний отрезок не сбрасывается никогда: задача заканчивается сразу за
   * циклом, и возобновлять после него уже нечего.
   */
  onSegment?: (rows: EnrichRow[], done: number) => Promise<boolean>;
}

/**
 * Тянет записи по уникальным ИНН чанками RPC_BATCH_SIZE.
 * Падение любого батча пробрасывается — частичный результат врал бы статистике.
 */
export async function fetchMatchRows(
  uniqueInns: string[],
  rpc: InnEnrichRpc,
  opts: FetchMatchRowsOptions = {},
): Promise<EnrichRow[]> {
  const { startIndex = 0, onProgress, onSegment } = opts;
  const segmentSize = onSegment && opts.segmentSize ? opts.segmentSize : 0;
  const rows: EnrichRow[] = [];
  let segment: EnrichRow[] = [];
  let done = Math.min(Math.max(startIndex, 0), uniqueInns.length);
  let flushedAt = done;
  for (const batch of chunkArray(uniqueInns.slice(done), RPC_BATCH_SIZE)) {
    const { data, error } = await rpc(batch);
    if (error) throw new Error(error.message);
    if (Array.isArray(data)) {
      rows.push(...data);
      if (segmentSize > 0) segment.push(...data);
    }
    done += batch.length;
    await onProgress?.(done, uniqueInns.length);
    if (segmentSize > 0 && done - flushedAt >= segmentSize && done < uniqueInns.length) {
      if (await onSegment!(segment, done)) {
        segment = [];
        flushedAt = done;
      }
    }
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
