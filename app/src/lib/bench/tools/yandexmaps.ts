import { z } from 'zod';
import type { BenchJobTool, JobRow } from '../types';

const paramsSchema = z
  .object({
    search_urls: z.array(z.string().url()).min(1).max(50),
    max_results: z.number().int().min(1).max(5000).default(1000),
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

export const yandexMapsTool: BenchJobTool = {
  id: 'yandexmaps',
  kind: 'job',
  title: 'Яндекс.Карты',
  table: 'yandex_maps_jobs',
  paramsSchema,

  // Строка ровно та же, что кладёт портал (см. app/src/app/api/parsers/
  // yandexmaps/route.ts). Воркер не отличает задачу витрины от задачи
  // человека — поэтому витрина не дублирует и не переписывает его логику.
  //
  // catalog_filters здесь всегда null: второй режим инструмента (поиск по
  // нашему каталогу) внутри ручки портала ветвится на «выполнить сразу» и
  // «поставить в очередь» по объёму, и по смыслу это поиск по собранной
  // базе, а не парсинг. Он относится к поисковой форме витрины.
  buildRow(params, ownerId) {
    const p = params as Params;
    return {
      user_id: ownerId,
      status: 'pending',
      config: {
        search_urls: p.search_urls,
        catalog_filters: null,
        max_results: p.max_results,
        headless: true,
      },
      progress_stage: 'pending',
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

  // total=0 означает «воркер ещё не знает объёма», а не «нечего делать».
  // Отдать наружу 0 значило бы показать «0 из 0» на живой задаче.
  progress(row: JobRow) {
    const total = num(row.total_organizations);
    return { done: num(row.processed_organizations), total: total || null };
  },

  rowsFound(row: JobRow) {
    return num(row.processed_organizations);
  },

  errorOf(row: JobRow) {
    return text(row.error_message);
  },

  finishedAt(row: JobRow) {
    return text(row.completed_at);
  },

  results: {
    kind: 'table',
    table: 'yandex_maps_organizations',
    jobColumn: 'job_id',
    orderColumn: 'created_at',
  },

  // У таблицы ограничение check (status in ('pending','running','completed',
  // 'failed')) — статуса «остановлена» нет, и ручки остановки у инструмента
  // тоже нет. Добавлять их значило бы менять миграцию и воркер работающего
  // парсера, что вне объёма витрины.
  stop: {
    supported: false,
    reason: 'Яндекс.Карты не поддерживают остановку задачи — дождитесь завершения',
  },
};
