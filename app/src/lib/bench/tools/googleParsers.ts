import { z } from 'zod';
import type { BenchJobTool, BenchStatus, JobRow } from '../types';

/**
 * Google Maps и Google News — близнецы: одна таблица-схема, один воркер, один
 * сервис. Различаются только именем таблицы, таблицей результатов и парой
 * параметров, поэтому оба собираются одной фабрикой.
 *
 * Оба поддерживают НАСТОЯЩУЮ остановку: воркер (app/lib/parsers/
 * googleParsersWorker.ts) опрашивает статус задачи и, увидев 'stopped',
 * командует сервису парсеров прервать работу. Это не косметическая смена
 * статуса — работа действительно прекращается, прокси перестают тратиться.
 */

const commonParams = {
  input_lines: z.array(z.string().min(1).max(500)).min(1).max(200),
  limit_per_query: z.number().int().min(1).max(1000).default(100),
  language: z.string().min(2).max(10).default('ru'),
  region: z.string().min(2).max(10).default('RU'),
};

const mapsParams = z
  .object({
    ...commonParams,
    enrich_contacts: z.boolean().default(true),
  })
  .strict();

const newsParams = z.object(commonParams).strict();

type MapsParams = z.infer<typeof mapsParams>;
type NewsParams = z.infer<typeof newsParams>;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Словарь статусов у Google-парсеров самый богатый в портале:
 * queued/running/paused/stopped/completed/failed плюс диагностические
 * captcha/blocked/timeout/login_required. Наружу их надо свернуть в общие
 * пять — но не потеряв смысл: captcha и blocked это провал, а не «выполнено».
 */
function mapGoogleStatus(row: JobRow): BenchStatus {
  switch (row.status) {
    case 'queued':
      return 'queued';
    case 'running':
    // Пауза наружу выглядит как «выполняется»: работа не завершена и
    // возобновится. Отдельного статуса «на паузе» витрина не обещает.
    case 'paused':
      return 'running';
    case 'completed':
      return 'done';
    case 'stopped':
      return 'stopped';
    default:
      // failed, captcha, blocked, timeout, login_required — всё это провал.
      // Подробность остаётся в поле error, чтобы причина не потерялась.
      return 'failed';
  }
}

function buildGoogleTool(config: {
  id: string;
  title: string;
  table: string;
  resultsTable: string;
  paramsSchema: typeof mapsParams | typeof newsParams;
  enrichContacts: boolean;
}): BenchJobTool {
  return {
    id: config.id,
    kind: 'job',
    title: config.title,
    table: config.table,
    paramsSchema: config.paramsSchema,

    buildRow(params, ownerId) {
      const p = params as MapsParams & Partial<NewsParams>;
      return {
        user_id: ownerId,
        status: 'queued',
        config: {
          inputLines: p.input_lines,
          limitPerQuery: p.limit_per_query,
          language: p.language,
          region: p.region,
          // Задержки между запросами наружу не отдаём: слишком малые значения
          // — прямой путь к капче и бану наших прокси, а последствия несёт
          // вся студия, а не автор скрипта.
          minDelayMs: 1200,
          maxDelayMs: 2800,
          enrichContacts: config.enrichContacts ? p.enrich_contacts !== false : false,
        },
        total_targets: p.input_lines.length,
        // Прокси задаёт портал из своего пула; из витрины их подставлять
        // нельзя — чужой список прокси в нашей инфраструктуре не место.
        proxy_enabled: false,
      };
    },

    mapStatus: mapGoogleStatus,

    progress(row: JobRow) {
      const total = num(row.total_targets);
      return { done: num(row.processed_targets), total: total || null };
    },

    rowsFound(row: JobRow) {
      return num(row.total_results);
    },

    errorOf(row: JobRow) {
      // message несёт диагностику вроде «captcha», error_message — аварию.
      return text(row.error_message) ?? text(row.message);
    },

    finishedAt(row: JobRow) {
      return text(row.completed_at);
    },

    results: {
      kind: 'table',
      table: config.resultsTable,
      jobColumn: 'job_id',
      orderColumn: 'id',
    },

    stop: { supported: true, stoppedStatus: 'stopped' },
  };
}

export const googleMapsTool = buildGoogleTool({
  id: 'googlemaps',
  title: 'Google Maps',
  table: 'google_maps_jobs',
  resultsTable: 'google_maps_places',
  paramsSchema: mapsParams,
  enrichContacts: true,
});

export const googleNewsTool = buildGoogleTool({
  id: 'googlenews',
  title: 'Google News',
  table: 'google_news_jobs',
  resultsTable: 'google_news_results',
  paramsSchema: newsParams,
  enrichContacts: false,
});
