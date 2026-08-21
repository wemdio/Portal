/**
 * Типы «Движка вертикалей» (Hypothesis Engine).
 *
 * Зеркалят строки таблиц `ve_*` (см. миграцию create_hypothesis_engine) и
 * формы jsonb-полей (evidence, letters, company_types, analysis и т.д.).
 * Префикс He — во избежание коллизий с типами остальных инструментов.
 */

/* ─────────────────────────── Enum-юнионы ─────────────────────────── */

export type VeStage =
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

export type VeJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type VeProjectStatus = 'draft' | 'researching' | 'researched' | 'failed';

export type VeHypothesisStatus = 'proposed' | 'accepted' | 'rejected';

/** 1 — очевидные ЦА, 2 — смежные сегменты, 3 — неочевидные рынки. */
export type VeHypothesisTier = 1 | 2 | 3;

export type VeBaseStatus = 'uploaded' | 'collecting' | 'analyzing' | 'analyzed' | 'failed';

export type VeTemplateStatus = 'draft' | 'ready';

export type VeDossierStatus = 'draft' | 'ready' | 'failed';

export type VeCaseSource = 'site' | 'upload';

export type VeChainLanguage = 'ru' | 'en' | 'pl';

export type VeCompanyTypeKind =
  | 'canonical'
  | 'synonym'
  | 'geo_variant'
  | 'adjacent'
  | 'slang';

/* ─────────────────────────── DB-строки ─────────────────────────── */

export interface VeProject {
  id: string;
  created_by: string | null;
  name: string;
  website_url: string;
  /** Снапшот брифа: { site_profile, website_url, captured_at, ... }. */
  brief: Record<string, unknown> | null;
  status: VeProjectStatus;
  /** Рынок проекта: ru (дефолт) | us — geo поиска и язык промптов/писем. */
  market: string;
  /** Автопилот ENG-кабинета: воркер сам дочейнит chain → base_collect → template. */
  autopilot?: boolean;
  error: string | null;
  llm_model: string | null;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface VeJob {
  id: string;
  project_id: string;
  stage: VeStage;
  status: VeJobStatus;
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

export interface VeHypothesis {
  id: string;
  project_id: string;
  vertical_id: string | null;
  tier: VeHypothesisTier;
  title: string;
  description: string;
  /** «Почему это рынок для клиента» (ЛПР → цель → боль → оффер). NULL/отсутствует у легаси-строк. */
  fit_rationale?: string | null;
  evidence: VeEvidenceItem[];
  potential_pct: number;
  status: VeHypothesisStatus;
  created_at: string;
  updated_at: string;
}

export interface VeVertical {
  id: string;
  project_id: string;
  name: string;
  summary: string | null;
  synonyms: string[];
  potential_pct: number;
  rank: number | null;
  /** Фактический reply% запущенных кампаний вертикали (петля сверки, null — не измерено). */
  actual_reply_pct?: number | null;
  /** Отправок в запущенных кампаниях на момент замера. */
  actual_sent?: number | null;
  /** Штамп последнего замера фактических метрик. */
  actual_measured_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface VeChain {
  id: string;
  vertical_id: string;
  language: string;
  letters: VeChainLetter[];
  status: string;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface VeVocab {
  id: string;
  vertical_id: string;
  company_types: VeCompanyType[];
  job_titles: VeJobTitle[];
  search_queries: VeSearchQuery[];
  created_at: string;
  updated_at: string;
}

export interface VeBase {
  id: string;
  project_id: string;
  vertical_id: string;
  filename: string;
  row_count: number;
  columns: string[];
  sample_rows: Array<Record<string, unknown>>;
  data: unknown;
  status: VeBaseStatus;
  analysis: VeBaseAnalysis | null;
  created_at: string;
  updated_at: string;
}

export interface VeTemplate {
  id: string;
  base_id: string;
  vertical_id: string;
  /** ~85% фиксированного содержания под гипотезу. */
  fixed_block: string;
  personalization_plan: VePersonalizationPlan;
  /** Финальные письма (fixed + 15% сегментной дописки + {{operators}}). */
  letters: VeChainLetter[];
  status: VeTemplateStatus;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface VeVerticalDossier {
  id: string;
  vertical_id: string;
  project_id: string;
  status: VeDossierStatus;
  /** Счётчики досье вертикали (VeDossierCounters, см. dossierData.ts). */
  data: Record<string, unknown>;
  error: string | null;
  llm_model: string | null;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface VeCase {
  id: string;
  project_id: string;
  source: VeCaseSource;
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
export interface VeEvidenceItem {
  claim: string;
  source_url: string;
  quote: string;
}

/** A/B-вариант письма: тот же шаг цепочки с другим поводом/углом (A — основной). */
export interface VeChainLetterVariant {
  subject: string | null;
  body: string;
}

export interface VeChainLetter {
  subject: string | null;
  body: string;
  /** Пауза в днях после предыдущего письма (у первого — 0). */
  wait_days: number;
  /** A/B-варианты (B, C…) для ручного выбора и A/B-теста в Instantly. */
  variants?: VeChainLetterVariant[];
  /**
   * Условные сегментные варианты тела (только финальные шаблоны ve_templates):
   * основной body — дефолт для всей базы, вариант идёт только лидам сегмента.
   */
  segment_variants?: VeSegmentVariant[];
}

export interface VeCompanyType {
  term: string;
  kind: VeCompanyTypeKind;
  geo?: string;
  notes?: string;
}

export interface VeJobTitle {
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

export interface VeSearchQuery {
  /** Источник: HH / LinkedIn / Maps / Registry / Catalog / ... */
  source: string;
  query: string;
  purpose?: string;
}

export interface VeDistributionEntry {
  value: string;
  share_pct: number;
}

/** Профиль загруженной базы (результат стадии base_analyze). */
export interface VeBaseAnalysis {
  geo_distribution: VeDistributionEntry[];
  industry_distribution: VeDistributionEntry[];
  company_type_distribution: VeDistributionEntry[];
  title_distribution: VeDistributionEntry[];
  notable_segments: string[];
  data_quality_notes: string;
  /** Углы/примеры под конкретно эту базу — основа 15% дописки шаблона. */
  recommended_angles: string[];
}

export interface VePersonalizationOperator {
  /** Имя оператора без фигурных скобок (например, firstName). */
  var: string;
  /** Колонка базы, из которой подставляется значение. */
  column: string;
  fallback?: string;
}

export interface VeLetterPersonalization {
  letter_index: number;
  operators: VePersonalizationOperator[];
}

export interface VeSegmentAddition {
  letter_index: number;
  /** Что дописать под базу (угол/пример/специфика сегмента). */
  addition: string;
  why?: string;
}

/**
 * Условный сегментный вариант письма (~15% дописки под базу): подменяет/дополняет
 * основной текст ТОЛЬКО для лидов сегмента `when`. Основной текст — дефолт.
 */
export interface VeSegmentVariant {
  /** Человекочитаемое условие сегмента из анализа базы (напр. «компании вне Москвы/СПб»). */
  when: string;
  /** Текст письма для этого сегмента. */
  text: string;
}

/** Сегментные варианты одного письма (1-based letter_index). */
export interface VeLetterSegmentVariants {
  letter_index: number;
  segment_variants: VeSegmentVariant[];
}

/** Маппинг оператора {{var}} на колонку базы (matched=false — колонки нет). */
export interface VeOperatorMapping {
  operator: string;
  column: string | null;
  matched: boolean;
  /** Текст подстановки при пустой ячейке (из плана; обязателен для unmatched). */
  fallback?: string;
}

export interface VePersonalizationPlan {
  letters: VeLetterPersonalization[];
  additions: VeSegmentAddition[];
  /** ~15%: условные сегментные варианты по письмам (основной текст — дефолт). */
  segment_variants?: VeLetterSegmentVariants[];
  /** Фактический маппинг операторов финальных писем на колонки базы. */
  operator_mapping?: VeOperatorMapping[];
}
