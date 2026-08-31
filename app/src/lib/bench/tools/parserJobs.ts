import { z } from 'zod';
import { ATS_COUNTRY_CODES } from '@/lib/parsers/atsFilters';
import { DEFAULT_ENG_HIRING_SOURCES, ENG_HIRING_SOURCES } from '@/lib/parsers/engHiring';
import type { BenchJobTool, BenchStatus, JobRow } from '../types';

/**
 * Три инструмента живут в одной таблице `parser_jobs` и различаются полем
 * `parser_type`: HH, ATS и англоязычный найм. Схема строки у них общая,
 * различаются только конфигурация поиска и таблица результатов.
 *
 * Ни один из трёх остановку не поддерживает: ограничение таблицы — check
 * (status in ('pending','running','completed','failed')), статуса
 * «остановлена» там нет, и проверки отмены в воркере тоже нет. Добавлять их
 * значило бы менять работающий парсер, что вне объёма витрины.
 */

const STOP_REASON =
  'Этот парсер не поддерживает остановку задачи — дождитесь завершения';

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapParserStatus(row: JobRow): BenchStatus {
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
}

/**
 * Прогресс у всей тройки считается одинаково: total_found — сколько нашли,
 * total_parsed — сколько разобрали. Оба поля nullable, пока воркер не начал.
 */
function parserProgress(row: JobRow) {
  const total = num(row.total_found);
  return { done: num(row.total_parsed), total: total || null };
}

const countryCodes = new Set<string>(ATS_COUNTRY_CODES);

const countriesField = z
  .array(z.string().min(2).max(10).toLowerCase())
  .max(50)
  .refine((list) => list.every((c) => countryCodes.has(c)), {
    message: 'Неизвестный код страны — допустимые коды смотрите в GET /tools',
  })
  .optional();

// ---------------------------------------------------------------- HH

const hhParams = z
  .object({
    text: z.string().min(1).max(200),
    area: z.union([z.string().min(1).max(20), z.array(z.string().min(1).max(20)).max(50)]).optional(),
    salary_from: z.number().int().min(0).max(100_000_000).optional(),
    currency: z.string().min(3).max(3).optional(),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    per_page: z.number().int().min(1).max(100).default(100),
    // Дозагрузка карточек работодателей заметно замедляет разбор, поэтому
    // это осознанный выбор вызывающего, а не умолчание «побольше данных».
    fetch_employers: z.boolean().default(true),
    strict_title_match: z.boolean().default(false),
  })
  .strict();

export const hhTool: BenchJobTool = {
  id: 'hh',
  kind: 'job',
  title: 'HH',
  table: 'parser_jobs',
  scope: { column: 'parser_type', value: 'hh_vacancies' },
  paramsSchema: hhParams,

  buildRow(params, ownerId) {
    return {
      user_id: ownerId,
      parser_type: 'hh_vacancies',
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config: params,
      total_found: null,
      total_parsed: null,
    };
  },

  mapStatus: mapParserStatus,
  progress: parserProgress,
  rowsFound: (row) => num(row.total_parsed),
  errorOf: (row) => text(row.error_message),
  finishedAt: (row) => text(row.completed_at),
  results: { kind: 'table', table: 'hh_vacancies', jobColumn: 'job_id', orderColumn: 'id' },
  stop: { supported: false, reason: STOP_REASON },
};

// --------------------------------------------------------------- ATS

// Роут портала намеренно сузил список до трёх систем, хотя парсер знает
// больше: витрина повторяет именно его выбор, а не возможности парсера.
const SUPPORTED_ATS = ['greenhouse', 'lever', 'ashby'] as const;

const atsParams = z
  .object({
    text: z.string().min(1).max(200).default('ATS companies'),
    ats: z.array(z.enum(SUPPORTED_ATS)).min(1).max(SUPPORTED_ATS.length).optional(),
    countries: countriesField,
    posted_within_days: z.number().int().min(0).max(3650).default(0),
    companies_limit: z.number().int().min(0).max(2000).default(200),
    enrich: z.boolean().default(true),
  })
  .strict();

export const atsTool: BenchJobTool = {
  id: 'ats',
  kind: 'job',
  title: 'ATS',
  table: 'parser_jobs',
  scope: { column: 'parser_type', value: 'ats_companies' },
  paramsSchema: atsParams,

  buildRow(params, ownerId) {
    const p = params as z.infer<typeof atsParams>;
    return {
      user_id: ownerId,
      parser_type: 'ats_companies',
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config: { ...p, ats: p.ats ?? [...SUPPORTED_ATS] },
      total_found: null,
      total_parsed: null,
    };
  },

  mapStatus: mapParserStatus,
  progress: parserProgress,
  rowsFound: (row) => num(row.total_parsed),
  errorOf: (row) => text(row.error_message),
  finishedAt: (row) => text(row.completed_at),
  results: { kind: 'table', table: 'ats_companies', jobColumn: 'job_id', orderColumn: 'id' },
  stop: { supported: false, reason: STOP_REASON },
};

// -------------------------------------------------------- ENG hiring

const engParams = z
  .object({
    text: z.string().min(1).max(200).default('english hiring'),
    sources: z.array(z.enum(ENG_HIRING_SOURCES as unknown as [string, ...string[]])).optional(),
    countries: countriesField,
    posted_within_days: z.number().int().min(0).max(3650).default(30),
    companies_limit: z.number().int().min(0).max(5000).default(1000),
    max_results: z.number().int().min(1).max(20_000).default(5000),
    cache_max_age_hours: z.number().int().min(1).max(24 * 14).default(12),
    refresh_cache: z.boolean().default(true),
    enrich: z.boolean().default(true),
    dedupe_companies: z.boolean().default(true),
    include_unknown_dates: z.boolean().default(false),
  })
  .strict();

export const engHiringTool: BenchJobTool = {
  id: 'eng-hiring',
  kind: 'job',
  title: 'ENG hiring',
  table: 'parser_jobs',
  scope: { column: 'parser_type', value: 'eng_hiring' },
  paramsSchema: engParams,

  buildRow(params, ownerId) {
    const p = params as z.infer<typeof engParams>;
    return {
      user_id: ownerId,
      parser_type: 'eng_hiring',
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config: { ...p, sources: p.sources ?? [...DEFAULT_ENG_HIRING_SOURCES] },
      total_found: null,
      total_parsed: null,
    };
  },

  mapStatus: mapParserStatus,
  progress: parserProgress,
  rowsFound: (row) => num(row.total_parsed),
  errorOf: (row) => text(row.error_message),
  finishedAt: (row) => text(row.completed_at),
  results: {
    kind: 'table',
    table: 'eng_hiring_vacancies',
    jobColumn: 'job_id',
    orderColumn: 'id',
  },
  stop: { supported: false, reason: STOP_REASON },
};
