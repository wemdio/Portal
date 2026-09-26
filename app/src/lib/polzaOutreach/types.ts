/**
 * Английский автоаутрич — общие типы конвейера.
 *
 * v2 по en-outreach-flow-improvements CEO (23.09.2026):
 *   компания → fit → поводы → данные → Lead Score → кейс → угол → цепочка.
 *
 * Конвейер (app/src/lib/polzaOutreach/runner.ts) — в порядке работы, дорогое
 * в конце (docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md §2 EN):
 *   S1 candidates       — вакансии sales/GTM (eng_hiring_cache) + стартапы YC (funded_companies)
 *   S2 resolveDomain    — домен компании; PDL даёт размер, страну, отрасль
 *   S3 icpFilter        — жёсткие отсевы: агентства/стаффинг/B2C, размер вне 3–200, дубль
 *                         домена; затем повторы между запусками (уже готова в другом запуске)
 *   S5 findEmail        — корпоративная почта с SMTP-проверкой и стоп-лист «Рассылки»,
 *                         у всех прошедших S3 и ДО разбора ИИ: за компанию без почты не платим
 *   S4 score            — сайт + вакансия (дешёвый ИИ) → поводы, fit, Lead Score v1, статус
 *   S6 buildLetters     — 4 письма CEO + детерминированные гарды
 * Номера стадий исторические: их хранит поле stage, и S5 с 26.09.2026 идёт до S4.
 *
 * Статусы строки: discovered → normalized → excluded | needs_review | qualified → ready.
 * Каждая стадия дописывает результат и не удаляет отсеянные строки — по ним
 * считается воронка (главный артефакт демо; lib/polzaOutreach/funnel.ts).
 */

import { sanitizeLlmBudgetUsd } from '@/lib/outreachLlm/types';

export type PolzaOutreachGeoConfidence = 'high' | 'medium' | 'low';

/** Гео-выборка MVP (спека §4/шаг 2 плана). `remote` и NULL не берём — гео недоказуемо. */
export const POLZA_OUTREACH_GEO_CODES = [
  'us', 'gb', 'ca', 'de', 'nl', 'sg', 'au', 'fr', 'se', 'ie', 'es', 'ch',
  'be', 'dk', 'no', 'fi', 'at', 'it', 'pl', 'pt', 'cz',
] as const;

/** Страны MVP-фильтра CEO: +5 баллов в Lead Score. */
export const POLZA_OUTREACH_PRIORITY_COUNTRIES = ['us', 'gb', 'ca', 'de', 'nl', 'sg', 'au'] as const;

export const POLZA_OUTREACH_DEFAULT_COUNTRIES: string[] = [...POLZA_OUTREACH_PRIORITY_COUNTRIES];

export const POLZA_OUTREACH_SOURCES = ['hiring', 'yc'] as const;
export type PolzaOutreachSource = (typeof POLZA_OUTREACH_SOURCES)[number];

export const POLZA_OUTREACH_DEFAULT_POSTED_WITHIN_DAYS = 30;
export const POLZA_OUTREACH_MIN_POSTED_WITHIN_DAYS = 1;
export const POLZA_OUTREACH_MAX_POSTED_WITHIN_DAYS = 45;

export const POLZA_OUTREACH_DEFAULT_LIMIT = 500;
export const POLZA_OUTREACH_MIN_LIMIT = 1;
// Потолок ГОТОВЫХ компаний за прогон: лимит считает выход конвейера, а не
// размер выборки — кандидатов раннер добирает волнами, пока не наберёт
// заказанное. Реальные месячные объёмы кэша меньше тысячи по всем странам
// сразу, так что потолок здесь — страховка, а не рабочее ограничение.
export const POLZA_OUTREACH_MAX_LIMIT = 1000;

export interface PolzaOutreachConfig {
  countries: string[];
  posted_within_days: number;
  limit: number;
  sources: PolzaOutreachSource[];
  /** YC: батчи не старше этого года. */
  yc_batch_from_year: number;
  min_employees: number;
  max_employees: number;
  /** Lead Score: ≥write — write now, ниже — skip (ручной проверки нет). */
  write_threshold: number;
  /**
   * Лимит расхода на ИИ за запуск, $. Дошли до него — запуск завершается
   * штатно (stop_reason 'budget'), готовое остаётся.
   */
  llm_budget_usd: number;
}

/**
 * Лимит на ИИ по умолчанию и его рамки — общие с русским аутричем, живут в
 * lib/outreachLlm/types.ts (модуль без Node-зависимостей: форма запуска —
 * клиентский компонент). Прежние имена оставлены для формы запуска.
 */
export {
  DEFAULT_LLM_BUDGET_USD as POLZA_OUTREACH_DEFAULT_LLM_BUDGET_USD,
  MIN_LLM_BUDGET_USD as POLZA_OUTREACH_MIN_LLM_BUDGET_USD,
  MAX_LLM_BUDGET_USD as POLZA_OUTREACH_MAX_LLM_BUDGET_USD,
} from '@/lib/outreachLlm/types';

/** Санитизация конфига задачи: один и тот же код в API-роуте и в раннере. */
export function sanitizePolzaOutreachConfig(raw: Partial<PolzaOutreachConfig>): PolzaOutreachConfig {
  const validCountries = new Set<string>(POLZA_OUTREACH_GEO_CODES);
  const countries = Array.isArray(raw.countries)
    ? Array.from(
        new Set(
          raw.countries
            .map((c) => String(c).toLowerCase().trim())
            .filter((c) => validCountries.has(c)),
        ),
      )
    : [];

  const clamp = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  };

  const sources = Array.isArray(raw.sources)
    ? Array.from(new Set(raw.sources.filter((s): s is PolzaOutreachSource => POLZA_OUTREACH_SOURCES.includes(s as PolzaOutreachSource))))
    : [];
  const minEmployees = clamp(raw.min_employees, 3, 1, 100_000);
  const write = clamp(raw.write_threshold, 75, 0, 100);

  return {
    countries: countries.length ? countries : [...POLZA_OUTREACH_DEFAULT_COUNTRIES],
    posted_within_days: clamp(
      raw.posted_within_days,
      POLZA_OUTREACH_DEFAULT_POSTED_WITHIN_DAYS,
      POLZA_OUTREACH_MIN_POSTED_WITHIN_DAYS,
      POLZA_OUTREACH_MAX_POSTED_WITHIN_DAYS,
    ),
    limit: clamp(raw.limit, POLZA_OUTREACH_DEFAULT_LIMIT, POLZA_OUTREACH_MIN_LIMIT, POLZA_OUTREACH_MAX_LIMIT),
    sources: sources.length ? sources : [...POLZA_OUTREACH_SOURCES],
    yc_batch_from_year: clamp(raw.yc_batch_from_year, 2023, 2005, 2100),
    min_employees: minEmployees,
    max_employees: Math.max(minEmployees, clamp(raw.max_employees, 200, 1, 100_000)),
    write_threshold: write,
    llm_budget_usd: sanitizeLlmBudgetUsd(raw.llm_budget_usd),
  };
}

/** Статусы строки (спека §17, подмножество MVP). */
export type PolzaOutreachRowStatus =
  | 'discovered'
  | 'normalized'
  | 'excluded'
  | 'needs_review'
  | 'qualified'
  | 'ready'
  | 'failed';

/**
 * Ключевые стадии конвейера для поля stage: последняя стадия, до которой
 * строка дошла (у отсеянной — на которой отсеяна). Значения хранятся в строках
 * прошлых запусков, поэтому не переименовываются, хотя с 26.09.2026 почта
 * (s5_email) идёт раньше разбора (s4_analyzed).
 */
export const POLZA_OUTREACH_STAGES = {
  s1Selected: 's1_selected',
  s2Domain: 's2_domain',
  /** Жёсткие отсевы, дубль домена и повторы между запусками. */
  s3Icp: 's3_icp',
  /** Исторически «разбор вакансии»; в v2 — разбор ИИ, поводы и Lead Score. */
  s4Analyzed: 's4_analyzed',
  /** Почта, её проверка и стоп-лист — до разбора ИИ. */
  s5Email: 's5_email',
  s6Letters: 's6_letters',
} as const;

export type PolzaOutreachStage = (typeof POLZA_OUTREACH_STAGES)[keyof typeof POLZA_OUTREACH_STAGES];

/** Кандидат S1: одна компания = одна самая свежая SDR/BDR-вакансия. */
export interface PolzaOutreachVacancyCandidate {
  vacancyId: string;
  jobTitle: string;
  jobSourceUrl: string;
  jobCountryCode: string;
  jobPublishedAt: string | null;
  companyName: string;
  companyDescription: string | null;
  /** Сайт компании прямо из кэша вакансий, если ATS его отдал. */
  companySiteUrl: string | null;
  vacancyDescription: string;
}

/** LLM-разбор S4 (строгая JSON-схема ответа модели). */
export interface PolzaVacancyAnalysis {
  outbound_mandate: boolean;
  outbound_evidence: string;
  service_line: string | null;
  service_line_confident: boolean;
  target_sales_geo: string | null;
  target_sales_geo_evidence: string;
  target_sales_geo_confidence: PolzaOutreachGeoConfidence;
  is_lead_gen_agency: boolean;
}

/** Письмо цепочки (letters jsonb). */
export interface PolzaOutreachLetter {
  n: number;
  subject: string;
  body: string;
}

/** Гарды S6: результат проверки готовой цепочки. */
export interface PolzaLetterGuardResult {
  ok: boolean;
  violations: string[];
}
