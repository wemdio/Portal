/**
 * Воркер джобы inn_enrich_jobs: скачивает исходный файл, матчит ИНН через
 * inn_enrich_fetch, кладёт готовый xlsx в storage. Перезапуск воркера
 * сбрасывает running → pending и прогоняет заново (файл ~90k ≈ 2 мин,
 * чекпоинт матчей не храним).
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { extractInns } from './extractInns';
import { buildEnrichmentStats } from './fields';
import { fetchMatchRows, rowsToMatchMap } from './match';
import { INN_ENRICH_BUCKET, MAX_INNS_PER_JOB, normalizeInn } from './inn';
import { readSpreadsheetBuffer } from './readFile';
import { buildEnrichedXlsxBuffer } from './workbook';

export interface InnEnrichJobRow {
  id: string;
  user_id: string;
  status: string;
  file_name: string;
  source_path: string | null;
  column_index: number;
  has_header: boolean;
}

function resultPath(jobId: string): string {
  return `${jobId}/result.xlsx`;
}

async function failJob(jobId: string, message: string): Promise<void> {
  const db = supabaseAdmin!;
  await db
    .from('inn_enrich_jobs')
    .update({
      status: 'failed',
      error_message: message,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .in('status', ['pending', 'running']);
}

export async function runInnEnrichJob(jobId: string): Promise<void> {
  const db = supabaseAdmin!;
  const { data: job, error: loadErr } = await db
    .from('inn_enrich_jobs')
    .select('id, user_id, status, file_name, source_path, column_index, has_header')
    .eq('id', jobId)
    .maybeSingle();

  if (loadErr || !job) {
    throw new Error(loadErr?.message ?? `inn_enrich job ${jobId} not found`);
  }

  const row = job as InnEnrichJobRow;
  if (!row.source_path) {
    await failJob(jobId, 'Исходный файл не загружен');
    return;
  }

  try {
    const { data: blob, error: dlErr } = await db.storage
      .from(INN_ENRICH_BUCKET)
      .download(row.source_path);
    if (dlErr || !blob) throw new Error(dlErr?.message ?? 'Не удалось скачать исходный файл');

    const buffer = Buffer.from(await blob.arrayBuffer());
    let table: string[][];
    try {
      table = await readSpreadsheetBuffer(row.file_name, buffer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failJob(
        jobId,
        /password|encrypt|unsupported encryption/i.test(msg)
          ? 'Файл защищён паролем — снимите защиту и загрузите снова'
          : `Не удалось прочитать файл: ${msg}`,
      );
      return;
    }

    if (row.column_index < 0 || row.column_index >= table.reduce((m, r) => Math.max(m, r.length), 0)) {
      await failJob(jobId, 'Не выбрана колонка с ИНН');
      return;
    }

    const { inns, invalidCount } = extractInns(table, row.column_index, row.has_header);
    if (inns.length === 0) {
      await failJob(jobId, 'В выбранной колонке нет валидных ИНН (10 или 12 цифр)');
      return;
    }
    if (inns.length > MAX_INNS_PER_JOB) {
      await failJob(jobId, `Слишком много ИНН: ${inns.length} (максимум ${MAX_INNS_PER_JOB})`);
      return;
    }

    await db
      .from('inn_enrich_jobs')
      .update({ total: inns.length, processed: 0 })
      .eq('id', jobId);

    const matchedRows = await fetchMatchRows(
      inns,
      (batch) => db.rpc('inn_enrich_fetch', { p_inn_list: batch }),
      async (done, total) => {
        await db
          .from('inn_enrich_jobs')
          .update({ processed: done, total, started_at: new Date().toISOString() })
          .eq('id', jobId)
          .eq('status', 'running');
      },
    );
    const matches = rowsToMatchMap(matchedRows);

    const dataStart = row.has_header ? 1 : 0;
    let matchedRowCount = 0;
    for (let r = dataStart; r < table.length; r += 1) {
      const inn = normalizeInn(table[r]?.[row.column_index]);
      if (inn && matches.has(inn)) matchedRowCount += 1;
    }

    const stats = buildEnrichmentStats({
      totalRows: table.length - dataStart,
      uniqueInns: inns.length,
      invalidValues: invalidCount,
      matchedRows: matchedRowCount,
      matched: Array.from(matches.values()),
    });

    const xlsx = await buildEnrichedXlsxBuffer({
      rows: table,
      columnIndex: row.column_index,
      hasHeader: row.has_header,
      matches,
      stats,
    });

    const path = resultPath(jobId);
    const { error: upErr } = await db.storage.from(INN_ENRICH_BUCKET).upload(path, xlsx, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: true,
    });
    if (upErr) throw new Error(upErr.message);

    await db
      .from('inn_enrich_jobs')
      .update({
        status: 'completed',
        processed: inns.length,
        total: inns.length,
        result_path: path,
        stats,
        error_message: null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  } catch (e) {
    await failJob(jobId, e instanceof Error ? e.message : String(e));
  }
}
