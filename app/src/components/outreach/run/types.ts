import type { ReactNode } from 'react';

/**
 * Общий экран запуска автоаутрича (английского и русского).
 *
 * Раскладка, таблица, окно этапа, выгрузки и кнопки — одни на оба языка:
 * доработка экрана сразу попадает в оба. Различаются только поиск (свои шаги
 * и источники) и данные строки — их язык отдаёт через адаптер. Адаптер
 * английского — components/parsers/polzaOutreachAdapter.tsx, русского —
 * components/polzaRuOutreach/ruAdapter.tsx.
 */

/** Запуск из parser_jobs — поля, которые читает общий экран. */
export interface OutreachRunJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | string;
  parser_type?: string;
  config?: { limit?: number | null } | null;
  progress_percent?: number | null;
  progress_detail?: unknown;
  total_parsed?: number | null;
  error_message?: string | null;
  created_at: string;
}

/** Ответ `/{jobId}/results` в части, общей для обоих языков. */
export interface OutreachResultsResponse<Row> {
  items: Row[];
  count: number;
  funnel?: Record<string, number> | null;
  status_counts?: Record<string, number> | null;
}

/** Статус строки для цвета и тона — у каждого языка свои коды, на экране шесть видов. */
export type OutreachRowTone = 'ready' | 'excluded' | 'review' | 'doubtful' | 'failed' | 'processing';

/** Письмо цепочки — одинаковой формы у обоих языков. */
export interface OutreachLetterView {
  n: number;
  subject: string;
  body: string;
  alt_body?: string;
  alt_routing?: boolean;
}

/** Столбец таблицы между «Доменом» и «Почтой» — у каждого языка свои четыре. */
export interface OutreachColumn<Row> {
  header: string;
  cell: (row: Row) => ReactNode;
}

/** Строка окна этапа: прошла ли и что этап про неё узнал. */
export interface OutreachStageEntry {
  id: string;
  company: string;
  link?: { href: string; label: string } | null;
  passed: boolean;
  detail: string;
  /** Цитата-доказательство под «Что нашли». */
  quote?: string | null;
  reason: string | null;
}

export interface OutreachStageData {
  entries: OutreachStageEntry[];
  /** Сколько прошло на самом деле, если в entries не все прошедшие (русский — витрина примеров). */
  passedTotal?: number;
  /** Пояснение под таблицей: «показаны примеры — полный список в Excel». */
  note?: string | null;
}

/** Фильтр над таблицей помимо «готовые / все» (русский: очень спорные, ручная проверка). */
export interface OutreachExtraFilter {
  status: string;
  label: string;
}

/** Дополнительная выгрузка Excel (русский: очень спорные). */
export interface OutreachExtraExport {
  label: string;
  kind: string;
}

export interface OutreachRunAdapter<Row extends { id: string }, Config, Job extends OutreachRunJob = OutreachRunJob> {
  /** База ручек запуска: `/api/parsers/polza-outreach`, `/api/tools/polza-ru-outreach`. */
  apiBase: string;
  /** parser_jobs.parser_type — живое обновление списка запусков. */
  parserType: string;
  lang: 'en' | 'ru';
  /** Начало имени файлов выгрузки. */
  filePrefix: string;
  emptyDescription: string;
  deleteDescription: string;

  /** Шаги конвейера — свои у каждого языка. */
  stages: Array<{ label: string; hint: string }>;
  stageCounts: (funnel: Record<string, number> | null | undefined) => number[];
  /** Разбор шага по клику: кто прошёл, кто нет и почему. */
  loadStage: (ctx: {
    jobId: string;
    stageIndex: number;
    funnel: Record<string, number> | null;
    loadAllRows: () => Promise<Row[]>;
  }) => Promise<OutreachStageData>;

  /** Что сейчас с запуском — расход на ИИ, причина остановки, SMTP. */
  runSummary: (job: Job | null) => {
    llm: { spent_usd: number; limit_usd: number; calls: number } | null;
    stopReason: string | null;
    smtpUnavailable: boolean;
    awaitingTemplates: number | null;
  };
  /** Своё под строкой расхода: ошибки источников, разбивка по цепочкам и т.п. */
  summaryExtras?: (job: Job) => ReactNode;

  readyCount: (resp: OutreachResultsResponse<Row> & Record<string, unknown>) => number | null;
  unverifiedCount: (resp: OutreachResultsResponse<Row> & Record<string, unknown>) => number;
  /** Причины отсева по всему запуску (код → число). */
  reasonCounts: (resp: OutreachResultsResponse<Row> & Record<string, unknown>) => Record<string, number> | null;
  reasonLabel: (code: string) => string;
  extraFilters?: OutreachExtraFilter[];

  // ── Строка таблицы ──
  companyName: (row: Row) => string;
  companyNote?: (row: Row) => string | null;
  domain: (row: Row) => string | null;
  website: (row: Row) => string | null;
  columns: OutreachColumn<Row>[];
  primaryEmail: (row: Row) => string | null;
  primaryVerification: (row: Row) => string | null;
  emails: (row: Row) => unknown;
  letters: (row: Row) => OutreachLetterView[];
  /** Вторая тема письма 1 (русский А/Б). */
  subjectB?: (row: Row) => string | null;
  tone: (row: Row) => OutreachRowTone;
  statusLabel: (row: Row) => string;
  /** Подпись под статусом: причина отсева или ручной проверки. */
  statusNote: (row: Row) => string | null;
  statusExtra?: (row: Row) => ReactNode;

  // ── Раскрытая строка ──
  detailHeading: (row: Row) => string;
  detailBlocks: (row: Row) => ReactNode;
  /** Жёлтая плашка «На ручную проверку: …». */
  reviewNote: (row: Row) => string | null;

  // ── Выгрузки ──
  csv: {
    readyHeader: string[];
    readyRow: (row: Row) => unknown[];
    fullHeader: string[];
    fullRow: (row: Row) => unknown[];
  };
  /** Адрес Excel под текущий фильтр таблицы. */
  xlsxUrl: (jobId: string, filter: string) => string;
  extraExports?: OutreachExtraExport[];
  extraExportUrl?: (jobId: string, kind: string) => string;

  /** Панель запуска — поиск у языков свой. */
  renderLaunchPanel: (props: {
    busy: boolean;
    initial: Config | null;
    onClose: () => void;
    onStart: (config: Config) => void;
  }) => ReactNode;
  jobConfig: (job: Job) => Config | null;
}
