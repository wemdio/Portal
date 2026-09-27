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
 *   S6 письма           — шаблон цепочки оффера (Gemini 3.1 Pro, один раз на тип главного
 *                         повода запуска; templateWriter.ts) + подстановка проверенных фактов
 *                         (renderTemplate.ts) + детерминированные гарды (buildLetters.ts)
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
  /**
   * Брать и компании, уже готовые в прошлых запусках (по умолчанию нет —
   * второй раз одной компании не пишем; как у русского аутрича).
   */
  include_previously_exported: boolean;
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
    include_previously_exported: raw.include_previously_exported === true,
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

/** Письмо цепочки (letters jsonb). Тема — только у письма 1: письма 2–4 идут ответом в той же ветке. */
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

/* ─────────────── Цепочки писем: шаблон на оффер (спека §4) ─────────────── */

/**
 * Оффер цепочки — тип главного повода компании (leadScore.primaryTrigger).
 * Цепочку пишет Gemini 3.1 Pro один раз на оффер запуска, под компанию
 * подставляются проверенные факты. none — повода нет: сейчас такие компании
 * отсеиваются до писем (no_trigger), ключ есть, чтобы строка без повода не
 * осталась без цепочки, если отсев когда-нибудь смягчат.
 */
export const POLZA_OFFER_KEYS = ['hiring', 'yc', 'launch', 'tech_stack', 'none'] as const;
export type PolzaOfferKey = (typeof POLZA_OFFER_KEYS)[number];

export const POLZA_OFFER_LABELS: Record<PolzaOfferKey, string> = {
  hiring: 'Найм в sales/GTM',
  yc: 'Стартап YC',
  launch: 'Запуск продукта',
  tech_stack: 'Стек продаж',
  none: 'Без повода',
};

export function isPolzaOfferKey(value: string): value is PolzaOfferKey {
  return (POLZA_OFFER_KEYS as readonly string[]).includes(value);
}

/**
 * Плейсхолдеры шаблона — только они меняются от компании к компании:
 * название, фраза-повод (triggerPhrase, из проверенного повода), короткий
 * повод для середины фразы (triggerShort), предложение об утверждённом кейсе,
 * блок первых сегментов (из разбора сайта) и подпись из настроек.
 */
export const POLZA_TEMPLATE_PLACEHOLDERS = {
  company: '{{company}}',
  trigger: '{{trigger}}',
  triggerShort: '{{trigger_short}}',
  case: '{{case}}',
  segments: '{{segments}}',
  signature: '{{signature}}',
} as const;
export type PolzaTemplatePlaceholder = (typeof POLZA_TEMPLATE_PLACEHOLDERS)[keyof typeof POLZA_TEMPLATE_PLACEHOLDERS];

/** Плейсхолдеры, которые может использовать шаблон оффера: без повода нет и фразы-повода. */
export function polzaTemplatePlaceholdersFor(offer: PolzaOfferKey): PolzaTemplatePlaceholder[] {
  const p = POLZA_TEMPLATE_PLACEHOLDERS;
  return [p.company, ...(offer === 'none' ? [] : [p.trigger]), p.triggerShort, p.case, p.segments, p.signature];
}

/**
 * Шаблон цепочки оффера в разобранном виде (в базе — polza_chain_templates.letters
 * по контракту писателя). Письмо 1 — в двух вариантах: лично (sales@, личный
 * адрес) и «кто у вас за это отвечает?» для общего ящика (info@, hello@);
 * письмо 3 — с кейсом и без. Кейс подбирается по отрасли любому офферу.
 */
export interface PolzaChainTemplateLetters {
  subject: string;
  bodyDirect: string;
  bodyRouting: string;
  letter2: string;
  bodyWithCase: string;
  bodyWithoutCase: string;
  letter4: string;
}

/* ─────────────────────── Подпись писем ─────────────────────── */

/**
 * Подпись по умолчанию — она же сид polza_outreach_settings.signature
 * (20260926_0001): до 26.09.2026 была константой в коде. Нужна, если
 * настройки нет или она пустая.
 */
export const POLZA_OUTREACH_DEFAULT_SIGNATURE = 'Julia Mira\nAccount Manager\nPolza Agency';
export const POLZA_OUTREACH_SIGNATURE_MAX_LENGTH = 500;

/**
 * Подпись из формы — в том виде, в каком она встанет в письма: переводы строк
 * одного вида, без хвостовых пробелов и лишних пустых строк. Гард писем сверяет
 * конец письма с подписью посимвольно — поэтому в базе лежит уже чистая.
 * Фигурные скобки запрещены: «{{…}}» в письме гард считает забытым
 * плейсхолдером, и все письма запуска ушли бы на ручную проверку.
 */
export function sanitizePolzaSignature(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Подпись должна быть текстом' };
  const value = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!value) return { ok: false, error: 'Подпись не может быть пустой' };
  if (value.length > POLZA_OUTREACH_SIGNATURE_MAX_LENGTH) {
    return { ok: false, error: `Подпись длиннее ${POLZA_OUTREACH_SIGNATURE_MAX_LENGTH} символов` };
  }
  if (/[{}]/.test(value)) return { ok: false, error: 'В подписи не должно быть фигурных скобок' };
  return { ok: true, value };
}

/* ─────────────────────── Причины ручной проверки ─────────────────────── */

/**
 * review_reason строки — код причины или «код: подробность» (у цепочки оффера,
 * которая не готова, и у писем, не прошедших гарды, — почему; у сбойной строки
 * там просто текст ошибки). Коды пишет раннер, подписи — одни на экран и
 * Excel. До 26.09.2026 раннер писал «letter_guard_failed: …», а подпись искала
 * «letters_guard_failed» — и экран показывал машинный код; старые строки
 * читаются той же подписью, что и новые.
 */
export const POLZA_REVIEW_LABELS: Record<string, string> = {
  email_unverified: 'почта не проверена: SMTP-проверка не дала ответа',
  template_failed: 'цепочка оффера не готова',
  letters_qa_failed: 'письма не прошли автопроверку',
  limit_reached: 'лимит готовых уже набран',
  letter_guard_failed: 'письма не прошли автопроверку',
  letters_guard_failed: 'письма не прошли автопроверку',
  no_corporate_email: 'не нашли корпоративную почту',
  generic_company: 'слишком общее описание компании',
  low_geo_confidence: 'гео продаж подтверждено слабо',
  manual_check: 'Lead Score в зоне ручной проверки',
};

const REVIEW_REASON_MAX = 500;

/** review_reason для строки: код и, если есть, подробность. */
export function polzaReviewReason(code: string, detail?: string | null): string {
  const text = detail?.replace(/\s+/g, ' ').trim();
  return (text ? `${code}: ${text}` : code).slice(0, REVIEW_REASON_MAX);
}

/** Код причины из review_reason; незнакомый текст (ошибка сбойной строки) — как есть. */
export function polzaReviewCode(reason: string): string {
  const m = /^([a-z_]+): /.exec(reason);
  return m && POLZA_REVIEW_LABELS[m[1]] ? m[1] : reason;
}

/** Подпись причины для экрана и Excel: «письма не прошли автопроверку — letter 2: …». */
export function polzaReviewLabel(reason: string): string {
  const code = polzaReviewCode(reason);
  const label = POLZA_REVIEW_LABELS[code];
  if (!label) return reason;
  const detail = reason.slice(code.length).replace(/^:\s*/, '').trim();
  return detail ? `${label} — ${detail}` : label;
}
