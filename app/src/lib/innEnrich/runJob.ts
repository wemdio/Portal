/**
 * Воркер джобы inn_enrich_jobs: скачивает исходный файл, матчит ИНН через
 * inn_enrich_fetch, кладёт готовый xlsx в storage.
 *
 * ── ВОЗОБНОВЛЕНИЕ ───────────────────────────────────────────────────────────
 * Раньше перезапуск воркера прогонял файл заново с нуля: цикл по батчам писал
 * число обработанных, но позицию нигде не хранил, а результаты копились только
 * в памяти процесса. Файл на 90 тысяч ИНН — это примерно две минуты чистых
 * запросов к базе, и каждый деплой начинал их сначала.
 *
 * Теперь у цикла есть курсор. Каждые RESUME_SEGMENT_INNS обработанных ИНН
 * накопленный отрезок результатов уезжает отдельным объектом в то же ведро
 * (`<jobId>/parts/NNNN.json`), а в колонку checkpoint ложится
 * {total, offset, parts}. Новый владелец скачивает уже сохранённые отрезки и
 * продолжает с offset.
 *
 * Почему позиционный курсор здесь корректен (проверено, а не предположено):
 *  - последовательность ИНН выводится ТОЛЬКО из файла: readSpreadsheetBuffer —
 *    чистая функция от байтов, extractInns идёт по строкам сверху вниз,
 *    dedupeInns — это Set, а он хранит порядок первого вхождения. Ни одной
 *    выборки из базы без сортировки и ни одного обхода словаря в этой цепочке
 *    нет, значит два запуска дают ПОБАЙТНО тот же список;
 *  - вход этой цепочки неизменен: source_path пишется один раз при создании
 *    задачи (upload с upsert:false), column_index и has_header после вставки
 *    строки никто не обновляет;
 *  - на всякий случай курсор всё равно сверяется с длиной списка (поле total):
 *    разошлась — курсор выбрасывается и файл считается с нуля, а не молча
 *    перепрыгивает кусок.
 *
 * Почему повтор отрезка не создаёт дублей:
 *  - отрезок кладётся по ДЕТЕРМИНИРОВАННОМУ имени (номер отрезка) с
 *    upsert:true — повтор перезаписывает тот же объект, а не добавляет второй;
 *  - курсор двигается только после успешной записи отрезка (onSegment
 *    возвращает false — буфер не очищается), поэтому «дырок» между отрезками не
 *    бывает;
 *  - и даже если один и тот же ИНН попадёт в результат дважды, итог собирается
 *    через rowsToMatchMap — Map по ИНН, где второй экземпляр вытесняет первый.
 *    Статистика считается по значениям этой Map, а matchedRowCount — по строкам
 *    исходного файла, так что от повтора не зависит ни одна цифра выгрузки.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { extractInns } from './extractInns';
import { buildEnrichmentStats } from './fields';
import type { EnrichRow } from './fields';
import { fetchMatchRows, rowsToMatchMap } from './match';
import { INN_ENRICH_BUCKET, MAX_INNS_PER_JOB, normalizeInn, RPC_BATCH_SIZE } from './inn';
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
  checkpoint: unknown;
}

/**
 * Через сколько обработанных ИНН сохранять отрезок результатов.
 *
 * Десять тысяч — это двадцать вызовов inn_enrich_fetch, то есть примерно
 * четверть минуты работы и один объект в хранилище на каждые 10k. При потолке
 * задачи в 100k (MAX_INNS_PER_JOB) отрезков не больше десяти, а задача меньше
 * 10k ИНН не платит за возобновление вообще ничего: последний отрезок не
 * сохраняется никогда (сразу за циклом задача и так закрывается).
 */
const RESUME_SEGMENT_INNS = 20 * RPC_BATCH_SIZE;

/** Курсор возобновления, лежит в колонке checkpoint. */
interface InnEnrichCheckpoint {
  /** Длина списка уникальных ИНН на момент записи курсора — сверка последовательности. */
  total: number;
  /** Сколько ИНН уже посчитано И сохранено в отрезках. */
  offset: number;
  /** Сколько отрезков лежит в хранилище: имена 0000 … (parts-1). */
  parts: number;
}

function resultPath(jobId: string): string {
  return `${jobId}/result.xlsx`;
}

function partPath(jobId: string, index: number): string {
  return `${jobId}/parts/${String(index).padStart(4, '0')}.json`;
}

type Db = NonNullable<typeof supabaseAdmin>;

/**
 * Убрать отрезки возобновления: задача закрыта, продолжать нечего.
 *
 * Зовётся только после УСПЕШНОЙ терминальной записи — иначе прежний владелец,
 * у которого задачу уже перехватили, стёр бы отрезки нового.
 */
async function removeResumeParts(db: Db, jobId: string): Promise<void> {
  try {
    const { data } = await db.storage.from(INN_ENRICH_BUCKET).list(`${jobId}/parts`, { limit: 1000 });
    const paths = (data ?? []).map((entry) => `${jobId}/parts/${entry.name}`);
    if (paths.length > 0) await db.storage.from(INN_ENRICH_BUCKET).remove(paths);
  } catch {
    // Осиротевший отрезок — мелочь: он лежит под идентификатором закрытой
    // задачи и никем больше не читается.
  }
}

/** true — терминальная запись легла в базу (значит, задача была нашей). */
async function failJob(db: Db, jobId: string, message: string): Promise<boolean> {
  const { data } = await db
    .from('inn_enrich_jobs')
    .update({
      status: 'failed',
      error_message: message,
      checkpoint: null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .in('status', ['pending', 'running'])
    .select('id')
    .maybeSingle();
  if (data) await removeResumeParts(db, jobId);
  return !!data;
}

/**
 * Поднять сохранённый отрезок результатов и позицию, с которой продолжать.
 *
 * Любое несовпадение — курсор чужой длины, битый JSON, недостающий объект —
 * трактуется как «возобновлять нечего»: лучше переиграть пару минут запросов,
 * чем собрать выгрузку с пропущенным куском.
 */
async function restoreResumePoint(
  db: Db,
  jobId: string,
  raw: unknown,
  total: number,
): Promise<{ offset: number; parts: number; rows: EnrichRow[] }> {
  const empty = { offset: 0, parts: 0, rows: [] as EnrichRow[] };
  if (!raw || typeof raw !== 'object') return empty;
  const cp = raw as Partial<InnEnrichCheckpoint>;
  if (cp.total !== total) return empty;
  if (!Number.isInteger(cp.offset) || !Number.isInteger(cp.parts)) return empty;
  const offset = cp.offset as number;
  const parts = cp.parts as number;
  if (offset <= 0 || offset > total || parts <= 0) return empty;

  const rows: EnrichRow[] = [];
  for (let index = 0; index < parts; index += 1) {
    const { data, error } = await db.storage.from(INN_ENRICH_BUCKET).download(partPath(jobId, index));
    if (error || !data) return empty;
    try {
      const parsed = JSON.parse(Buffer.from(await data.arrayBuffer()).toString('utf8'));
      if (!Array.isArray(parsed)) return empty;
      rows.push(...(parsed as EnrichRow[]));
    } catch {
      return empty;
    }
  }
  return { offset, parts, rows };
}

export async function runInnEnrichJob(jobId: string): Promise<void> {
  const db = supabaseAdmin!;
  const { data: job, error: loadErr } = await db
    .from('inn_enrich_jobs')
    .select('id, user_id, status, file_name, source_path, column_index, has_header, checkpoint')
    .eq('id', jobId)
    .maybeSingle();

  if (loadErr || !job) {
    throw new Error(loadErr?.message ?? `inn_enrich job ${jobId} not found`);
  }

  const row = job as InnEnrichJobRow;
  if (!row.source_path) {
    await failJob(db, jobId, 'Исходный файл не загружен');
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
        db,
        jobId,
        /password|encrypt|unsupported encryption/i.test(msg)
          ? 'Файл защищён паролем — снимите защиту и загрузите снова'
          : `Не удалось прочитать файл: ${msg}`,
      );
      return;
    }

    if (row.column_index < 0 || row.column_index >= table.reduce((m, r) => Math.max(m, r.length), 0)) {
      await failJob(db, jobId, 'Не выбрана колонка с ИНН');
      return;
    }

    const { inns, invalidCount } = extractInns(table, row.column_index, row.has_header);
    if (inns.length === 0) {
      await failJob(db, jobId, 'В выбранной колонке нет валидных ИНН (10 или 12 цифр)');
      return;
    }
    if (inns.length > MAX_INNS_PER_JOB) {
      await failJob(db, jobId, `Слишком много ИНН: ${inns.length} (максимум ${MAX_INNS_PER_JOB})`);
      return;
    }

    const resume = await restoreResumePoint(db, jobId, row.checkpoint, inns.length);
    let parts = resume.parts;

    // processed выставляем по курсору, а не в ноль: иначе возобновлённая задача
    // сперва откатывала бы счётчик пользователю, а потом прыгала вперёд.
    await db
      .from('inn_enrich_jobs')
      .update({ total: inns.length, processed: resume.offset })
      .eq('id', jobId);

    let segmentWriteWarned = false;
    const fetched = await fetchMatchRows(
      inns,
      (batch) => db.rpc('inn_enrich_fetch', { p_inn_list: batch }),
      {
        startIndex: resume.offset,
        onProgress: async (done, total) => {
          await db
            .from('inn_enrich_jobs')
            .update({ processed: done, total, started_at: new Date().toISOString() })
            .eq('id', jobId)
            .eq('status', 'running');
        },
        segmentSize: RESUME_SEGMENT_INNS,
        onSegment: async (segmentRows, done) => {
          const index = parts;
          // upsert:true и детерминированное имя: повтор того же отрезка
          // перезаписывает объект, а не добавляет второй.
          const { error: partErr } = await db.storage.from(INN_ENRICH_BUCKET).upload(
            partPath(jobId, index),
            Buffer.from(JSON.stringify(segmentRows), 'utf8'),
            { contentType: 'application/json', upsert: true },
          );
          if (partErr) {
            if (!segmentWriteWarned) {
              segmentWriteWarned = true;
              console.warn(`inn_enrich ${jobId}: не удалось сохранить отрезок ${index}: ${partErr.message}`);
            }
            // Курсор не двигаем: эти строки уедут в следующую попытку вместе с
            // новыми, под тем же номером отрезка.
            return false;
          }
          parts = index + 1;
          const checkpoint: InnEnrichCheckpoint = { total: inns.length, offset: done, parts };
          await db
            .from('inn_enrich_jobs')
            .update({ checkpoint })
            .eq('id', jobId)
            .eq('status', 'running');
          return true;
        },
      },
    );
    const matches = rowsToMatchMap([...resume.rows, ...fetched]);

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

    const { data: finished } = await db
      .from('inn_enrich_jobs')
      .update({
        status: 'completed',
        processed: inns.length,
        total: inns.length,
        result_path: path,
        stats,
        checkpoint: null,
        error_message: null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'running')
      .select('id')
      .maybeSingle();
    if (finished) await removeResumeParts(db, jobId);
  } catch (e) {
    await failJob(db, jobId, e instanceof Error ? e.message : String(e));
  }
}
