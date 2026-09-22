/**
 * «Наш автоаутрич» — русский сигнальный аутрич Polza. Общие типы конвейера.
 *
 * Три независимых ручных оффера (профиля). Профиль фиксируется точкой запуска:
 * неподходящая компания получает rejected/manual_review с причиной и никогда
 * не переводится в другой оффер (LAUNCH_INSTRUCTIONS_INDEX, «Модель запуска»).
 *
 *   sdr_hiring_v1          — компания нанимает SDR / активные продажи; 3 письма
 *   automated_outreach_v1  — автоматизированный аутрич по нескольким сегментам; 3 письма
 *   signals_v1             — прочий подтверждённый realtime-сигнал; 4 письма
 *
 * Дизайн: docs/superpowers/specs/2026-09-22-polza-ru-outreach-design.md.
 */

export const RU_OUTREACH_PARSER_TYPE = 'polza_ru_outreach' as const;

export const PROFILE_CODES = ['sdr_hiring_v1', 'automated_outreach_v1', 'signals_v1'] as const;
export type ProfileCode = (typeof PROFILE_CODES)[number];

export const PROFILE_LABELS: Record<ProfileCode, string> = {
  sdr_hiring_v1: 'Найм SDR',
  automated_outreach_v1: 'Автоматизация аутрича',
  signals_v1: 'По сигналам',
};

export const LETTER_COUNT: Record<ProfileCode, number> = {
  sdr_hiring_v1: 3,
  automated_outreach_v1: 3,
  signals_v1: 4,
};

export const TEMPLATE_VERSION: Record<ProfileCode, string> = {
  sdr_hiring_v1: 'sdr_hiring_v1@2026-09-22',
  automated_outreach_v1: 'automated_outreach_v1@2026-09-22',
  signals_v1: 'signals_v1@2026-09-22',
};

export const SOURCE_CODES = ['hh', 'crm', 'hh_multi', 'hh_sales', 'contracts', 'exhibitors', 'site_news'] as const;
export type SourceCode = (typeof SOURCE_CODES)[number];

export const SOURCE_LABELS: Record<SourceCode, string> = {
  hh: 'Вакансии hh.ru',
  crm: 'AMO: прошлые лиды и клиенты',
  hh_multi: 'hh.ru: несколько вакансий продаж',
  hh_sales: 'hh.ru: вакансии продаж',
  contracts: 'Госконтракты (загруженные выгрузки ЕИС)',
  exhibitors: 'Выставки (загруженные каталоги)',
  site_news: 'Новости и разделы партнёрам/дилерам на сайтах',
};

/** Какие источники разрешены профилю (SOURCE_CONNECTORS §12, дизайн §1). */
export const PROFILE_SOURCES: Record<ProfileCode, SourceCode[]> = {
  sdr_hiring_v1: ['hh'],
  automated_outreach_v1: ['crm', 'hh_multi'],
  signals_v1: ['hh_sales', 'contracts', 'exhibitors', 'site_news'],
};

export type RelationshipFilter = 'cold' | 'prior_contact' | 'mixed';

export interface RuOutreachConfig {
  profile_code: ProfileCode;
  sources: SourceCode[];
  /** Окно свежести сигнала, дней (дата источника, не дата загрузки). */
  freshness_days: number;
  /** Сколько ГОТОВЫХ компаний нужно (а не сколько кандидатов просмотреть). */
  limit: number;
  relationship_filter: RelationshipFilter;
  /** Порог скоринга компании для оффера «по сигналам» (SPEC §10). */
  min_signal_score: number;
  include_previously_exported: boolean;
  sender_id: string | null;
}

export const DEFAULT_FRESHNESS: Record<ProfileCode, number> = {
  sdr_hiring_v1: 45,
  automated_outreach_v1: 60,
  signals_v1: 30,
};
export const MIN_FRESHNESS_DAYS = 1;
export const MAX_FRESHNESS_DAYS = 180;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const DEFAULT_MIN_SIGNAL_SCORE = 8;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Санитизация конфига: один код в API-роуте и в раннере. */
export function sanitizeRuOutreachConfig(raw: Partial<RuOutreachConfig>): RuOutreachConfig {
  const profile: ProfileCode = PROFILE_CODES.includes(raw.profile_code as ProfileCode)
    ? (raw.profile_code as ProfileCode)
    : 'sdr_hiring_v1';
  const allowed = PROFILE_SOURCES[profile];
  const sources = Array.isArray(raw.sources)
    ? Array.from(new Set(raw.sources.filter((s): s is SourceCode => allowed.includes(s as SourceCode))))
    : [];
  const relationship: RelationshipFilter =
    raw.relationship_filter === 'cold' || raw.relationship_filter === 'prior_contact'
      ? raw.relationship_filter
      : 'mixed';
  const senderId = typeof raw.sender_id === 'string' && /^[0-9a-f-]{36}$/i.test(raw.sender_id) ? raw.sender_id : null;

  return {
    profile_code: profile,
    sources: sources.length ? sources : [...allowed],
    freshness_days: clampInt(raw.freshness_days, DEFAULT_FRESHNESS[profile], MIN_FRESHNESS_DAYS, MAX_FRESHNESS_DAYS),
    limit: clampInt(raw.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    relationship_filter: relationship,
    min_signal_score: clampInt(raw.min_signal_score, DEFAULT_MIN_SIGNAL_SCORE, 0, 15),
    include_previously_exported: raw.include_previously_exported === true,
    sender_id: senderId,
  };
}

export type RowStatus = 'processing' | 'ready' | 'rejected' | 'manual_review' | 'failed';

/** Этапы конвейера (поле pipeline_stage). Порядок = порядок воронки. */
export const STAGES = [
  'candidates_loaded',
  'source_checked',
  'company_resolved',
  'deduplicated',
  'icp_checked',
  'evidence_classified',
  'recipient_resolved',
  'sequence_assembled',
  'qa_checked',
  'ready',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  candidates_loaded: 'Кандидаты',
  source_checked: 'Источник проверен',
  company_resolved: 'Компания и домен',
  deduplicated: 'Без повторов',
  icp_checked: 'Прошли ICP',
  evidence_classified: 'Сигнал и режим',
  recipient_resolved: 'Найдена почта',
  sequence_assembled: 'Цепочка собрана',
  qa_checked: 'Прошли QA',
  ready: 'Готово',
};

/** Коды отсева и ручной проверки (INSTRUCTION_02 §9, INSTRUCTION_03 §11 + сигналы). */
export const REASON_LABELS: Record<string, string> = {
  SOURCE_RECORD_INVALID: 'Запись источника неполная',
  VACANCY_INVALID: 'Вакансия недоступна',
  VACANCY_STALE: 'Вакансия старше окна свежести',
  VACANCY_CLOSED: 'Вакансия закрыта или в архиве',
  JOB_FUNCTION_NOT_SDR: 'Вакансия не про активные продажи',
  SDR_EVIDENCE_MISSING: 'Нет цитаты про холодный поиск / лидогенерацию',
  EMPLOYER_AMBIGUOUS: 'Работодатель не определён',
  COMPANY_AMBIGUOUS: 'Компания не определена однозначно',
  DUPLICATE_COMPANY: 'Повтор компании в запуске',
  PREVIOUSLY_EXPORTED: 'Уже выгружалась раньше',
  NOT_B2B: 'Не B2B',
  EXCLUDED_CATEGORY: 'Исключённая категория (кадровое агентство, конкурент, B2C)',
  AUTOMATION_FIT_TOO_WEAK: 'Мало признаков для автоматизации (нужно ≥2)',
  SEGMENTS_NOT_IDENTIFIABLE: 'Не видно нескольких сегментов',
  RELATIONSHIP_NOT_CONFIRMED: 'Прошлое общение не подтверждено AMO',
  SIGNAL_TOO_WEAK: 'Скоринг сигнала ниже порога',
  SIGNAL_STALE: 'Сигнал старше окна свежести',
  SIGNAL_EVIDENCE_AMBIGUOUS: 'Сигнал без дословного подтверждения',
  DOMAIN_NOT_FOUND: 'Не найден сайт компании',
  EMAIL_NOT_FOUND: 'Не найдена корпоративная почта',
  EMAIL_INVALID: 'Почта некорректна',
  SUPPRESSED_CONTACT: 'Почта в стоп-листе',
  TEMPLATE_DATA_MISSING: 'Не хватает данных для шаблона',
  SENDER_MISSING: 'Нет активной подписи отправителя',
  QA_FACT_UNSUPPORTED: 'QA: неподтверждённый факт',
  QA_PLACEHOLDER_LEFT: 'QA: остались переменные',
  QA_FAILED: 'QA не пройден',
  PROCESSING_ERROR: 'Ошибка обработки',
};

export type EvidenceLevel = 'A' | 'B' | 'C' | 'NONE';

export type SignalType =
  | 'sdr_hiring'
  | 'sales_hiring'
  | 'multiple_sales_vacancies'
  | 'trade_show_exhibitor'
  | 'contract_won'
  | 'product_launch'
  | 'new_region'
  | 'new_office'
  | 'new_production'
  | 'partner_program'
  | 'dealer_search'
  | 'export_launch'
  | 'new_case'
  | 'multiple_products'
  | 'multiple_regions'
  | 'b2b_product';

/** Один найденный факт о компании с доказательством. */
export interface Signal {
  type: SignalType;
  source: SourceCode;
  /** Должность, название выставки, предмет контракта, заголовок новости. */
  title: string;
  date: string | null;
  url: string | null;
  /** Дословная цитата из первоисточника (A) или пусто для структурного поля (B). */
  quote: string | null;
  level: EvidenceLevel;
  /** Доп. поля источника: сумма и заказчик контракта, даты выставки и т.п. */
  meta?: Record<string, unknown>;
}

export interface Letter {
  n: number;
  subject: string;
  body: string;
}

export interface QaResult {
  status: 'passed' | 'failed';
  flags: string[];
}
