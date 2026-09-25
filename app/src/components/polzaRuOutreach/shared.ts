'use client';

import { authFetch, authFetchJson } from '@/lib/authFetch';
import { CHAIN_LABELS, type ChainType, type Letter, type RuOutreachConfig, type Signal, type Stage } from '@/lib/polzaRuOutreach/types';

export const API = '/api/tools/polza-ru-outreach';

export interface RuJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  config: RuOutreachConfig;
  progress_stage: string | null;
  progress_percent: number | null;
  progress_detail: {
    pool?: number;
    chains?: Record<string, number>;
    /** Компании с вакансиями продаж: сколько в SDR, сколько ушло в общую очередь. */
    sdr?: { any_sales_vacancy: number; strict_sdr: number; broad_to_general_queue: number };
    scanned?: number;
    ready?: number;
    target?: number;
    stop_reason?: string;
    reasons?: Record<string, number>;
    source_errors?: Record<string, string>;
    doubtful?: number;
  } | null;
  total_found: number | null;
  total_parsed: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RuRow {
  id: string;
  chain_type: ChainType | null;
  source_type: string;
  source_url: string | null;
  source_urls: string[];
  company_name: string;
  company_brand: string | null;
  inn: string | null;
  normalized_domain: string | null;
  company_website: string | null;
  prior_contact: boolean;
  amo_status: string | null;
  ta_score: number | null;
  ta_reason: string | null;
  priority_score: number | null;
  case_match_reason: string | null;
  campaign_hypothesis: string | null;
  email_verification: string | null;
  signal_type: string | null;
  signal_date: string | null;
  signal_title: string | null;
  evidence_quote: string | null;
  evidence_level: string | null;
  market_evidence_quote: string | null;
  target_market: string | null;
  signals: Signal[];
  fit_reasons: string[];
  signal_score: number | null;
  generation_mode: string | null;
  recipient_email: string | null;
  email_type: string | null;
  recipient_role: string | null;
  is_routing: boolean | null;
  letters: Letter[] | null;
  subject_b: string | null;
  case_id: string | null;
  qa_status: string | null;
  qa_flags: string[];
  row_status: 'processing' | 'ready' | 'rejected' | 'manual_review' | 'failed' | 'doubtful';
  pipeline_stage: string | null;
  reason_code: string | null;
  reason_detail: string | null;
  doubt_flags: string[];
  doubt_detail: string | null;
  route_reason: string | null;
  route_runner_up: string | null;
}

export const api = authFetchJson;

/** Скачивание файла, который собирает сервер (Excel). */
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Не удалось выгрузить (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export const STATUS_LABELS: Record<RuRow['row_status'], string> = {
  processing: 'в работе',
  ready: 'готово',
  rejected: 'отсеяна',
  manual_review: 'ручная проверка',
  failed: 'ошибка',
  doubtful: 'очень спорная',
};

export const SIGNAL_LABELS: Record<string, string> = {
  sales_hiring: 'вакансия продаж',
  ad_running: 'реклама в Яндекс.Директе',
  grant_or_accelerator: 'грант / акселератор',
  crm_lost: 'старый отказ в AMO',
  trade_show_exhibitor: 'участник выставки',
  contract_won: 'госконтракт',
  product_launch: 'новый продукт',
  new_region: 'новый регион',
  new_office: 'новый офис',
  new_production: 'новое производство',
  partner_program: 'партнёрская программа',
  dealer_search: 'ищут дилеров',
  export_launch: 'экспорт',
  new_case: 'новый кейс',
  sales_team: 'отдел продаж (2ГИС)',
  revenue_growth: 'рост выручки (ФНС)',
  tender_won: 'выигранный тендер',
  investment: 'инвестиции',
  sales_hiring_broad: 'вакансия продаж (не SDR)',
};

export const MODE_LABELS: Record<string, string> = CHAIN_LABELS;

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('ru-RU');
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Ответ `/{jobId}/results`: строки страницы плюс счётчики для воронки и фильтров. */
export interface ResultsResponse {
  items: RuRow[];
  count: number;
  funnel: Record<Stage, number>;
  reason_counts: Record<string, number>;
  status_counts: Record<string, number>;
}

/** Быстрые фильтры над таблицей результатов. */
export type ResultsFilter = 'ready' | 'doubtful' | 'manual_review' | 'rejected' | 'all';

export const RESULT_FILTERS: Array<[ResultsFilter, string]> = [
  ['ready', 'Готовые'],
  ['doubtful', 'Очень спорные'],
  ['manual_review', 'Ручная проверка'],
  ['rejected', 'Отсеянные'],
  ['all', 'Все'],
];

/** Сколько строк результатов на странице. */
export const RESULTS_PAGE = 50;
