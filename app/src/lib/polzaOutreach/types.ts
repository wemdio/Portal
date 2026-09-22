/**
 * Polza ENG outreach MVP — общие типы конвейера.
 *
 * Конвейер (стадии S1..S6, app/src/lib/polzaOutreach/runner.ts):
 *   S1 selectVacancies  — свежие SDR/BDR-вакансии из eng_hiring_cache (source=jobhive)
 *   S2 resolveDomain    — домен компании через PDL-резолвер
 *   S3 icpFilter        — дешёвые исключения по названию/описанию/домену/размеру
 *   S4 analyzeVacancy   — LLM: outbound-мандат + гео продаж + услуга, с цитатами
 *   S5 findEmail        — корпоративная почта на сайте компании
 *   S6 buildLetters     — цепочка «SDR hiring-trigger» + детерминированные гарды
 *
 * Статусы строки: discovered → normalized → excluded | needs_review | qualified → ready.
 * Каждая стадия дописывает результат и не удаляет отсеянные строки — по ним
 * считается воронка (главный артефакт демо).
 */

export type PolzaOutreachGeoConfidence = 'high' | 'medium' | 'low';

/** Гео-выборка MVP (спека §4/шаг 2 плана). `remote` и NULL не берём — гео недоказуемо. */
export const POLZA_OUTREACH_GEO_CODES = [
  'us', 'ca', 'gb', 'de', 'nl', 'fr', 'se', 'ie', 'es', 'ch',
  'be', 'dk', 'no', 'fi', 'at', 'it', 'pl', 'pt', 'cz',
] as const;

export const POLZA_OUTREACH_DEFAULT_COUNTRIES: string[] = [...POLZA_OUTREACH_GEO_CODES];

export const POLZA_OUTREACH_DEFAULT_POSTED_WITHIN_DAYS = 30;
export const POLZA_OUTREACH_MIN_POSTED_WITHIN_DAYS = 1;
export const POLZA_OUTREACH_MAX_POSTED_WITHIN_DAYS = 45;

export const POLZA_OUTREACH_DEFAULT_LIMIT = 100;
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
}

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

  return {
    countries: countries.length ? countries : [...POLZA_OUTREACH_DEFAULT_COUNTRIES],
    posted_within_days: clamp(
      raw.posted_within_days,
      POLZA_OUTREACH_DEFAULT_POSTED_WITHIN_DAYS,
      POLZA_OUTREACH_MIN_POSTED_WITHIN_DAYS,
      POLZA_OUTREACH_MAX_POSTED_WITHIN_DAYS,
    ),
    limit: clamp(raw.limit, POLZA_OUTREACH_DEFAULT_LIMIT, POLZA_OUTREACH_MIN_LIMIT, POLZA_OUTREACH_MAX_LIMIT),
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

/** Ключевые стадии конвейера для поля stage (воронка по ним). */
export const POLZA_OUTREACH_STAGES = {
  s1Selected: 's1_selected',
  s2Domain: 's2_domain',
  s3Icp: 's3_icp',
  s4Analyzed: 's4_analyzed',
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
