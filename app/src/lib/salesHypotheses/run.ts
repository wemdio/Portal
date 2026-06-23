/**
 * Shared shapes for the «Гипотезы по сайту» tool (/tools/sales-hypotheses).
 *
 * Прогон = один сайт, прогнанный через автозаполнение брифа + генерацию гипотез.
 * Бриф (brief_fields / brief_text) сохраняется в БД для дебага, но НЕ отдаётся
 * в UI — сейлз видит только сайт, статус и итоговые гипотезы.
 */

export type SalesHypothesesRunStatus = 'autofilled' | 'generating' | 'completed' | 'failed';

/** Колонки для списка истории (без тяжёлых тел брифа/гипотез). */
export const RUN_LIST_COLUMNS =
  'id, website, resolved_url, status, error_message, hypotheses_generated_at, created_at, updated_at';

/**
 * Колонки для детального прогона: включают гипотезы и уточняющие вопросы, но НЕ
 * бриф (brief_fields / brief_text намеренно остаются только на сервере).
 */
export const RUN_DETAIL_COLUMNS =
  'id, website, resolved_url, status, hypotheses, autofill_questions, hypotheses_generated_at, hypotheses_model, error_message, created_at, updated_at';

export interface SalesHypothesesRunRow {
  id: string;
  website: string;
  resolved_url: string | null;
  status: SalesHypothesesRunStatus;
  hypotheses?: string | null;
  autofill_questions?: unknown;
  hypotheses_generated_at?: string | null;
  hypotheses_model?: string | null;
  error_message: string | null;
  created_at: string;
  updated_at?: string;
}

/** Client-facing DTO. Camel-cased, без серверных полей брифа. */
export interface SalesHypothesesRunDTO {
  id: string;
  website: string;
  resolvedUrl: string | null;
  status: SalesHypothesesRunStatus;
  hypotheses: string | null;
  questions: string[];
  hypothesesGeneratedAt: string | null;
  error: string | null;
  createdAt: string;
}

export function serializeRun(row: SalesHypothesesRunRow): SalesHypothesesRunDTO {
  const questions = Array.isArray(row.autofill_questions)
    ? (row.autofill_questions as unknown[]).filter((q): q is string => typeof q === 'string')
    : [];
  return {
    id: row.id,
    website: row.website,
    resolvedUrl: row.resolved_url ?? null,
    status: row.status,
    hypotheses: row.hypotheses ?? null,
    questions,
    hypothesesGeneratedAt: row.hypotheses_generated_at ?? null,
    error: row.error_message ?? null,
    createdAt: row.created_at,
  };
}
