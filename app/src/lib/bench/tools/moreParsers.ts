import { z } from 'zod';
import type { BenchJobTool, BenchStatus, JobRow } from '../types';

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ------------------------------------------------------- Архив HH

const hhArchiveParams = z
  .object({
    search_queries: z.array(z.string().min(1).max(200)).min(1).max(100),
    // Код региона HH; 113 — вся Россия.
    area: z.string().min(1).max(20).default('113'),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    archived: z.boolean().default(true),
    chunk_strategy: z.enum(['single', 'monthly', 'weekly', 'daily']).default('monthly'),
    max_results: z.number().int().min(1).max(200_000).default(50_000),
  })
  .strict()
  .refine((v) => v.date_from <= v.date_to, {
    message: 'date_from не может быть позже date_to',
  });

export const hhArchiveTool: BenchJobTool = {
  id: 'hh-archive',
  kind: 'job',
  title: 'HH архив',
  table: 'hh_archive_jobs',
  paramsSchema: hhArchiveParams,

  buildRow(params, ownerId) {
    return { user_id: ownerId, ...(params as Record<string, unknown>) };
  },

  mapStatus(row: JobRow): BenchStatus {
    switch (row.status) {
      case 'pending':
        return 'queued';
      case 'processing':
        return 'running';
      case 'completed':
        return 'done';
      case 'cancelled':
        return 'stopped';
      default:
        return 'failed';
    }
  },

  // Прогресс считается в чанках дат, а не в вакансиях: инструмент режет
  // период на куски и идёт по ним, и «3 из 12 месяцев» честнее показывает,
  // сколько осталось, чем число уже найденных строк.
  progress(row: JobRow) {
    const total = num(row.total_chunks);
    return { done: num(row.processed_chunks), total: total || null };
  },

  rowsFound: (row) => num(row.saved_total),
  errorOf: (row) => text(row.error_message),
  finishedAt: (row) => text(row.completed_at),
  results: {
    kind: 'table',
    table: 'hh_archive_results',
    jobColumn: 'job_id',
    orderColumn: 'id',
  },
  // Раннер проверяет статус между запросами (app/src/lib/parsers/hhArchive/
  // runner.ts) — отмена действительно прекращает работу.
  stop: { supported: true, stoppedStatus: 'cancelled' },
};

// ------------------------------------------- Поисковый парсер

const searchParams = z
  .object({
    queries: z.array(z.string().min(1).max(300)).min(1).max(200),
    // Глубина выдачи: сколько страниц результатов забирать по каждому запросу.
    search_depth: z.number().int().min(1).max(30).default(5),
  })
  .strict();

export const searchParserTool: BenchJobTool = {
  id: 'search',
  kind: 'job',
  title: 'Поисковый парсер',
  table: 'search_parser_jobs',
  paramsSchema: searchParams,

  buildRow(params, ownerId) {
    const p = params as z.infer<typeof searchParams>;
    return {
      user_id: ownerId,
      status: 'pending',
      config: { queries: p.queries, search_depth: p.search_depth },
      total_queries: p.queries.length,
    };
  },

  mapStatus(row: JobRow): BenchStatus {
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
    const total = num(row.total_queries);
    return { done: num(row.processed_queries), total: total || null };
  },

  rowsFound: (row) => num(row.total_results),
  errorOf: (row) => text(row.error_message),
  finishedAt: (row) => text(row.completed_at),
  results: { kind: 'table', table: 'search_results', jobColumn: 'job_id', orderColumn: 'id' },
  // check (status in ('pending','running','completed','failed')) — статуса
  // остановки в таблице нет, проверки отмены в воркере тоже.
  stop: {
    supported: false,
    reason: 'Поисковый парсер не поддерживает остановку задачи — дождитесь завершения',
  },
};

// --------------------------------------------- Яндекс.Директ

const yandexDirectParams = z
  .object({
    niche: z.string().min(1).max(200).default(''),
    // 'manual' — ключи заданы списком; 'ai' — генерируются по описанию
    // аудитории. Во втором случае keywords заполняет воркер.
    keyword_mode: z.enum(['manual', 'ai']).default('manual'),
    keywords: z.array(z.string().min(1).max(200)).max(2000).default([]),
    audience: z.string().max(2000).default(''),
    n_seeds: z.number().int().min(1).max(60).default(20),
    regions: z.array(z.string().min(1).max(30)).min(1).max(50).default(['msk']),
    expand_suggest: z.boolean().default(true),
    include_organic: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.keyword_mode !== 'manual' || v.keywords.length > 0, {
    message: 'При keyword_mode=manual нужен непустой список keywords',
  })
  .refine((v) => v.keyword_mode !== 'ai' || v.audience.trim().length > 0, {
    message: 'При keyword_mode=ai нужно описание аудитории в audience',
  });

export const yandexDirectTool: BenchJobTool = {
  id: 'yandex-direct',
  kind: 'job',
  title: 'Яндекс.Директ',
  table: 'yandex_direct_jobs',
  paramsSchema: yandexDirectParams,

  buildRow(params, ownerId) {
    return { user_id: ownerId, ...(params as Record<string, unknown>) };
  },

  mapStatus(row: JobRow): BenchStatus {
    switch (row.status) {
      case 'pending':
        return 'queued';
      case 'processing':
        return 'running';
      case 'completed':
        return 'done';
      case 'cancelled':
        return 'stopped';
      default:
        return 'failed';
    }
  },

  progress(row: JobRow) {
    const total = num(row.total_requests);
    return { done: num(row.processed_requests), total: total || null };
  },

  // saved_total — уникальные домены, found_advertisers считает и дубли.
  // Наружу отдаём то, что реально ляжет в результат.
  rowsFound: (row) => num(row.saved_total),
  errorOf: (row) => text(row.error_message),
  finishedAt: (row) => text(row.completed_at),
  results: {
    kind: 'table',
    table: 'yandex_direct_results',
    jobColumn: 'job_id',
    orderColumn: 'id',
  },
  // Раннер проверяет статус между запросами (app/src/lib/parsers/
  // yandexDirect/runner.ts) — отмена настоящая.
  stop: { supported: true, stoppedStatus: 'cancelled' },
};
