/**
 * Контракт между общим раннером и обработчиком оффера.
 *
 * Раннер делает общее для всех офферов: вставку строк журнала, домен, дедуп
 * внутри запуска и против прошлых выгрузок, стоп-лист, поиск почты, сборку
 * контекста писем, QA и запись статусов. Обработчик оффера отвечает за
 * источник кандидатов, проверку источника, ICP/fit, сигнал и сборку цепочки.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssembledChain, LetterContext } from './letters/common';
import type { Libraries } from './libraries';
import type { EvidenceLevel, RuOutreachConfig, Signal, SourceCode, Stage } from './types';

/** Кандидат из источника — до любых проверок. */
export interface Candidate {
  /** Ключ дедупа внутри запуска до появления домена (ИНН, employer, имя). */
  key: string;
  sourceType: SourceCode;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  sourceUrls: string[];
  companyName: string;
  inn: string | null;
  website: string | null;
  hhEmployerId: string | null;
  crmLeadId: number | null;
  priorContact: boolean;
  priorContactDate: string | null;
  /** Адрес из CRM: человек, с которым уже говорили (корпоративный домен). */
  crmEmail: string | null;
  /** Сигналы, известные уже из источника (структурные поля — уровень B). */
  signals: Signal[];
  /** Данные источника для обработчика оффера (вакансии hh, флаги AMO …). */
  payload: Record<string, unknown>;
}

/** Результат проверки кандидата обработчиком оффера. */
export type QualifyResult =
  | { ok: false; stage: Stage; status: 'rejected' | 'manual_review' | 'failed'; reason: string; detail?: string; patch?: RowPatch }
  | { ok: true; patch: RowPatch; letterInput: unknown; allowedFacts: string[]; tags: string[] };

/** Поля строки журнала, которые обработчик заполняет по ходу проверки. */
export interface RowPatch {
  source_url?: string | null;
  source_urls?: string[];
  signal_type?: string | null;
  signal_date?: string | null;
  signal_title?: string | null;
  evidence_quote?: string | null;
  evidence_level?: EvidenceLevel | null;
  market_evidence_quote?: string | null;
  target_market?: string | null;
  signals?: Signal[];
  fit_reasons?: string[];
  signal_score?: number | null;
  generation_mode?: string | null;
  prior_contact?: boolean;
  prior_contact_date?: string | null;
  company_website?: string | null;
  normalized_domain?: string | null;
  inn?: string | null;
}

export interface RunContext {
  db: SupabaseClient;
  jobId: string;
  config: RuOutreachConfig;
  libraries: Libraries;
  tagVocabulary: string[];
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

/** Строка в работе: кандидат + то, что уже известно о компании. */
export interface WorkRow {
  id: string;
  candidate: Candidate;
  domain: string | null;
  website: string | null;
}

export interface ProfileHandler {
  /** Загрузить пул кандидатов один раз на запуск; вернуть его размер. */
  prepare(ctx: RunContext): Promise<number>;
  /** Следующая порция кандидатов; пустой массив — пул исчерпан. */
  nextWave(want: number): Candidate[];
  /** Проверка источника (вакансия жива, свежесть) до поиска домена. */
  checkSource?(row: WorkRow, ctx: RunContext): Promise<QualifyResult | null>;
  /** Сайт компании, если источник его не дал (например, работодатель на hh). */
  resolveWebsite?(row: WorkRow, ctx: RunContext): Promise<string | null>;
  /** ICP/fit, сигнал, режим генерации. */
  qualify(row: WorkRow, ctx: RunContext): Promise<QualifyResult>;
  /** Сборка цепочки для прошедшей строки. */
  assemble(row: WorkRow, letterCtx: LetterContext, letterInput: unknown, ctx: RunContext): Promise<AssembledChain>;
  /** Порог после поиска почты (скоринг сигналов учитывает найденный контакт). */
  gateAfterEmail?(row: WorkRow, patch: RowPatch, emailType: string | null, ctx: RunContext): QualifyResult | null;
  /** Освободить промежуточные данные строки (раннер зовёт на любом исходе). */
  release?(row: WorkRow): void;
}

export function reject(
  stage: Stage,
  reason: string,
  detail?: string,
  status: 'rejected' | 'manual_review' | 'failed' = 'rejected',
  patch?: RowPatch,
): QualifyResult {
  return { ok: false, stage, status, reason, detail, patch };
}
