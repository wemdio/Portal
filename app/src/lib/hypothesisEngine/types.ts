/**
 * Типы «Движка вертикалей» (Hypothesis Engine).
 *
 * Зеркалят строки таблиц `he_*` (см. миграцию create_hypothesis_engine) и
 * формы jsonb-полей (evidence, letters, company_types, analysis и т.д.).
 * Префикс He — во избежание коллизий с типами остальных инструментов.
 */

/* ─────────────────────────── Enum-юнионы ─────────────────────────── */

export type HeStage =
  | 'site_profile'
  | 'competitors'
  | 'brand_cloud'
  | 'hypotheses'
  | 'evidence'
  | 'clustering'
  | 'chain'
  | 'vocab'
  | 'base_analyze'
  | 'base_collect'
  | 'template'
  | 'dossier';

export type HeJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type HeProjectStatus = 'draft' | 'researching' | 'researched' | 'failed';

export type HeHypothesisStatus = 'proposed' | 'accepted' | 'rejected';

/** 1 — очевидные ЦА, 2 — смежные сегменты, 3 — неочевидные рынки. */
export type HeHypothesisTier = 1 | 2 | 3;

export type HeBaseStatus = 'uploaded' | 'collecting' | 'analyzing' | 'analyzed' | 'failed';

export type HeTemplateStatus = 'draft' | 'ready';

export type HeDossierStatus = 'draft' | 'ready' | 'failed';

export type HeCaseSource = 'site' | 'upload';

export type HeChainLanguage = 'ru' | 'en' | 'pl';

export type HeCompanyTypeKind =
  | 'canonical'
  | 'synonym'
  | 'geo_variant'
  | 'adjacent'
  | 'slang';

/* ─────────────────────────── DB-строки ─────────────────────────── */

export interface HeProject {
  id: string;
  created_by: string | null;
  name: string;
  website_url: string;
  /** Снапшот брифа: { site_profile, website_url, captured_at, ... }. */
  brief: Record<string, unknown> | null;
  status: HeProjectStatus;
  error: string | null;
  llm_model: string | null;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface HeJob {
  id: string;
  project_id: string;
  stage: HeStage;
  status: HeJobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempts: number;
  error: string | null;
  started_at: string | null;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface HeHypothesis {
  id: string;
  project_id: string;
  vertical_id: string | null;
  tier: HeHypothesisTier;
  title: string;
  description: string;
  /** «Почему это рынок для клиента» (ЛПР → цель → боль → оффер). NULL/отсутствует у легаси-строк. */
  fit_rationale?: string | null;
  evidence: HeEvidenceItem[];
  potential_pct: number;
  status: HeHypothesisStatus;
  created_at: string;
  updated_at: string;
}

export interface HeVertical {
  id: string;
  project_id: string;
  name: string;
  summary: string | null;
  synonyms: string[];
  potential_pct: number;
  rank: number | null;
  created_at: string;
  updated_at: string;
}

export interface HeChain {
  id: string;
  vertical_id: string;
  language: string;
  letters: HeChainLetter[];
  status: string;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface HeVocab {
  id: string;
  vertical_id: string;
  company_types: HeCompanyType[];
  job_titles: HeJobTitle[];
  search_queries: HeSearchQuery[];
  created_at: string;
  updated_at: string;
}

export interface HeBase {
  id: string;
  project_id: string;
  vertical_id: string;
  filename: string;
  row_count: number;
  columns: string[];
  sample_rows: Array<Record<string, unknown>>;
  data: unknown;
  status: HeBaseStatus;
  analysis: HeBaseAnalysis | null;
  created_at: string;
  updated_at: string;
}

export interface HeTemplate {
  id: string;
  base_id: string;
  vertical_id: string;
  /** ~85% фиксированного содержания под гипотезу. */
  fixed_block: string;
  personalization_plan: HePersonalizationPlan;
  /** Финальные письма (fixed + 15% сегментной дописки + {{operators}}). */
  letters: HeChainLetter[];
  status: HeTemplateStatus;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface HeVerticalDossier {
  id: string;
  vertical_id: string;
  project_id: string;
  status: HeDossierStatus;
  /** Счётчики досье вертикали (HeDossierCounters, см. dossierData.ts). */
  data: Record<string, unknown>;
  error: string | null;
  llm_model: string | null;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface HeCase {
  id: string;
  project_id: string;
  source: HeCaseSource;
  /** Имя файла для source='upload'. */
  filename: string | null;
  /** Отрасль/вертикаль клиента из кейса. */
  industry: string | null;
  client_type: string | null;
  /** Задача клиента из кейса. */
  task: string | null;
  /** Структурированные метрики результата. */
  metrics: Record<string, unknown>;
  /** Достигнутый результат. */
  result: string | null;
  /** Полный текст кейса. */
  text: string | null;
  created_at: string;
  updated_at: string;
}

/* ─────────────────────── jsonb-подструктуры ─────────────────────── */

/** Единичное доказательство гипотезы. URL — только реально найденный поиском. */
export interface HeEvidenceItem {
  claim: string;
  source_url: string;
  quote: string;
}

/** A/B-вариант письма: тот же шаг цепочки с другим поводом/углом (A — основной). */
export interface HeChainLetterVariant {
  subject: string | null;
  body: string;
}

export interface HeChainLetter {
  subject: string | null;
  body: string;
  /** Пауза в днях после предыдущего письма (у первого — 0). */
  wait_days: number;
  /** A/B-варианты (B, C…) для ручного выбора и A/B-теста в Instantly. */
  variants?: HeChainLetterVariant[];
  /**
   * Условные сегментные варианты тела (только финальные шаблоны he_templates):
   * основной body — дефолт для всей базы, вариант идёт только лидам сегмента.
   */
  segment_variants?: HeSegmentVariant[];
}

export interface HeCompanyType {
  term: string;
  kind: HeCompanyTypeKind;
  geo?: string;
  notes?: string;
}

export interface HeJobTitle {
  title: string;
  /**
   * Сторона аудитории (vocab-схема пишет всегда; в старых записях поля нет):
   * buyer — ЛПР компаний вертикали (кому агентство продаёт);
   * campaign_target — цели будущих кампаний клиентов вертикали.
   */
  audience_side?: 'buyer' | 'campaign_target';
  seniority?: string;
  function?: string;
  geo?: string;
  alt_names?: string[];
}

export interface HeSearchQuery {
  /** Источник: HH / LinkedIn / Maps / Registry / Catalog / ... */
  source: string;
  query: string;
  purpose?: string;
}

export interface HeDistributionEntry {
  value: string;
  share_pct: number;
}

/** Профиль загруженной базы (результат стадии base_analyze). */
export interface HeBaseAnalysis {
  geo_distribution: HeDistributionEntry[];
  industry_distribution: HeDistributionEntry[];
  company_type_distribution: HeDistributionEntry[];
  title_distribution: HeDistributionEntry[];
  notable_segments: string[];
  data_quality_notes: string;
  /** Углы/примеры под конкретно эту базу — основа 15% дописки шаблона. */
  recommended_angles: string[];
}

export interface HePersonalizationOperator {
  /** Имя оператора без фигурных скобок (например, firstName). */
  var: string;
  /** Колонка базы, из которой подставляется значение. */
  column: string;
  fallback?: string;
}

export interface HeLetterPersonalization {
  letter_index: number;
  operators: HePersonalizationOperator[];
}

export interface HeSegmentAddition {
  letter_index: number;
  /** Что дописать под базу (угол/пример/специфика сегмента). */
  addition: string;
  why?: string;
}

/**
 * Условный сегментный вариант письма (~15% дописки под базу): подменяет/дополняет
 * основной текст ТОЛЬКО для лидов сегмента `when`. Основной текст — дефолт.
 */
export interface HeSegmentVariant {
  /** Человекочитаемое условие сегмента из анализа базы (напр. «компании вне Москвы/СПб»). */
  when: string;
  /** Текст письма для этого сегмента. */
  text: string;
}

/** Сегментные варианты одного письма (1-based letter_index). */
export interface HeLetterSegmentVariants {
  letter_index: number;
  segment_variants: HeSegmentVariant[];
}

/** Маппинг оператора {{var}} на колонку базы (matched=false — колонки нет). */
export interface HeOperatorMapping {
  operator: string;
  column: string | null;
  matched: boolean;
  /** Текст подстановки при пустой ячейке (из плана; обязателен для unmatched). */
  fallback?: string;
}

export interface HePersonalizationPlan {
  letters: HeLetterPersonalization[];
  additions: HeSegmentAddition[];
  /** ~15%: условные сегментные варианты по письмам (основной текст — дефолт). */
  segment_variants?: HeLetterSegmentVariants[];
  /** Фактический маппинг операторов финальных писем на колонки базы. */
  operator_mapping?: HeOperatorMapping[];
}
