import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { INN_ENRICH_BUCKET, MAX_INNS_PER_JOB } from '@/lib/innEnrich/inn';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { BenchJobTool, JobRow } from '../types';

/**
 * Обогащение по ИНН.
 *
 * В портале инструмент принимает файл: человек загружает таблицу, выбирает
 * колонку с ИНН, файл ложится в хранилище, а воркер читает его оттуда.
 * Снаружи файлы принимать неудобно и незачем — скрипту проще передать список
 * прямо в запросе, как это уже сделано у конструктора баз. Поэтому витрина
 * берёт список, сама собирает из него CSV и кладёт в то же хранилище: воркер
 * не отличает такую задачу от загруженной человеком.
 */

const paramsSchema = z
  .object({
    // Валидация формы ИНН здесь намеренно мягкая (10 или 12 цифр): строгую
    // нормализацию делает сам инструмент, и дублировать её значило бы
    // получить два расходящихся правила.
    inns: z
      .array(z.string().regex(/^\d{10}(\d{2})?$/, 'ИНН — это 10 или 12 цифр'))
      .min(1)
      .max(MAX_INNS_PER_JOB),
    file_name: z.string().min(1).max(200).default('bench-api.csv'),
  })
  .strict();

type Params = z.infer<typeof paramsSchema>;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const innEnrichTool: BenchJobTool = {
  id: 'inn-enrich',
  kind: 'job',
  title: 'Обогащение по ИНН',
  table: 'inn_enrich_jobs',
  paramsSchema,

  /**
   * Складываем список в CSV и кладём в хранилище. Идентификатор задачи
   * генерируем заранее — путь к файлу строится из него, как в портале.
   *
   * Ведро закрыто для обычных пользователей, поэтому пишем служебным
   * доступом. Чужих данных это не касается: путь состоит из идентификатора
   * задачи, которую мы прямо сейчас и создаём.
   */
  async prepare({ params }): Promise<JobRow> {
    const p = params as Params;
    if (!supabaseAdmin) throw new Error('Хранилище недоступно');

    const id = randomUUID();
    const sourcePath = `${id}/source.csv`;
    // Заголовок нужен, потому что задача создаётся с has_header=true —
    // так же, как выглядит обычная выгрузка из таблицы.
    const csv = ['inn', ...p.inns].join('\n');

    const { error } = await supabaseAdmin.storage
      .from(INN_ENRICH_BUCKET)
      .upload(sourcePath, Buffer.from(csv, 'utf8'), {
        contentType: 'text/csv',
        upsert: false,
      });
    if (error) throw new Error(error.message);

    return { id, source_path: sourcePath, total: p.inns.length };
  },

  async rollback(prepared: JobRow): Promise<void> {
    const path = text(prepared.source_path);
    if (!supabaseAdmin || !path) return;
    try {
      await supabaseAdmin.storage.from(INN_ENRICH_BUCKET).remove([path]);
    } catch {
      // Осиротевший файл — мелочь по сравнению с ошибкой, которую мы уже
      // возвращаем вызывающему; молчим, чтобы не подменить её собой.
    }
  },

  buildRow(params, ownerId) {
    const p = params as Params;
    return {
      user_id: ownerId,
      status: 'pending',
      file_name: p.file_name,
      column_index: 0,
      has_header: true,
    };
  },

  mapStatus(row: JobRow) {
    switch (row.status) {
      case 'pending':
        return 'queued';
      case 'running':
        return 'running';
      case 'completed':
        return 'done';
      default:
        return 'failed';
    }
  },

  progress(row: JobRow) {
    const total = num(row.total);
    return { done: num(row.processed), total: total || null };
  },

  rowsFound: (row) => num(row.processed),
  errorOf: (row) => text(row.error_message),
  finishedAt: (row) => text(row.completed_at),

  // Результат воркер кладёт файлом в то же хранилище (result_path), строк в
  // базе не появляется — поэтому витрина отдаёт временную ссылку, а не
  // страницы строк.
  results: { kind: 'file', bucket: INN_ENRICH_BUCKET, pathField: 'result_path' },

  stop: {
    supported: false,
    reason: 'Обогащение по ИНН не поддерживает остановку задачи — дождитесь завершения',
  },
};
