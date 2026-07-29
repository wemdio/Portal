/**
 * Zod-схемы структурированных ответов LLM для «Движка вертикалей».
 *
 * Использование: `callLLMWithSchema(messages, HeXSchema, ...)` — LLM отвечает
 * через response_format: json_object, Zod валидирует, при mismatch — 1 retry.
 *
 * Общие правила для всех схем (дублируются в промптах):
 *  - недостающие факты — пустые строки/массивы, НЕ выдуманные значения;
 *  - URL в evidence — только реально найденные поиском (см. prompts/evidence).
 */

import { z } from 'zod';

/* ─────────────────────── site_profile ─────────────────────── */

export const HeSiteProfileSchema = z.object({
  company_name: z.string(),
  product_summary: z.string(),
  usp: z.array(z.string()).default([]),
  price_tier: z.enum(['low', 'medium', 'high', 'enterprise', 'unknown']).default('unknown'),
  deal_cycle: z.string().default(''),
  target_audience: z.string().default(''),
  current_clients: z.array(z.string()).default([]),
  cases: z.array(z.string()).default([]),
  geo: z.string().default(''),
  business_model: z.string().default(''),
});
export type HeSiteProfileOutput = z.infer<typeof HeSiteProfileSchema>;

/* ─────────────────────── competitors ─────────────────────── */

export const HeCompetitorListSchema = z.object({
  competitors: z
    .array(
      z.object({
        name: z.string(),
        url: z.string(),
        why: z.string().default(''),
        geo: z.string().default(''),
      }),
    )
    .min(1)
    .max(12),
});
export type HeCompetitorListOutput = z.infer<typeof HeCompetitorListSchema>;

/* ─────────────────────── brand_cloud ─────────────────────── */

export const HeBrandCloudSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(['company', 'brand', 'product', 'person', 'media', 'other']).default('other'),
        /** anomaly — не клиент (шум/несуразица); noise — типично; potential — рынок с потенциалом. */
        classification: z.enum(['anomaly', 'noise', 'potential']),
        potential_pct: z.number().int().min(0).max(100),
        rationale: z.string().default(''),
      }),
    )
    .default([]),
});
export type HeBrandCloudOutput = z.infer<typeof HeBrandCloudSchema>;

/* ─────────────────────── hypotheses (проход a) ─────────────────────── */

export const HeHypothesisCandidateSchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  title: z.string(),
  description: z.string(),
  /**
   * «Почему это рынок для клиента» (обязательна): цепочка ЛПР сегмента →
   * его цель → его боль, которую снимает продукт клиента → оффер клиента.
   */
  fit_rationale: z.string().min(1),
  rationale: z.string().default(''),
  potential_pct: z.number().int().min(0).max(100),
  /** Точные поисковые запросы для стадии верификации. */
  search_queries: z.array(z.string()).default([]),
});
export type HeHypothesisCandidate = z.infer<typeof HeHypothesisCandidateSchema>;

export const HeHypothesesBatchSchema = z.object({
  hypotheses: z.array(HeHypothesisCandidateSchema).min(1),
});
export type HeHypothesesBatchOutput = z.infer<typeof HeHypothesesBatchSchema>;

/* ─────────────────────── evidence (проход b) ─────────────────────── */

export const HeEvidenceItemSchema = z.object({
  claim: z.string(),
  source_url: z.string(),
  quote: z.string().max(500),
});

export const HeEvidenceVerdictSchema = z.object({
  verdict: z.enum(['keep', 'merge', 'drop']),
  /** Точный title другой гипотезы-кандидата — только для verdict=merge. */
  merge_with_title: z.string().nullable().default(null),
  reason: z.string().default(''),
  /** «Почему это рынок для клиента»: пронести из кандидата или уточнить по фактам (для drop — пустая). */
  fit_rationale: z.string().default(''),
  evidence: z.array(HeEvidenceItemSchema).default([]),
  /** Перекалиброванный по фактам процент потенциала. */
  potential_pct: z.number().int().min(0).max(100),
});
export type HeEvidenceVerdict = z.infer<typeof HeEvidenceVerdictSchema>;

/* ─────────────────────── clustering ─────────────────────── */

export const HeClusteringSchema = z.object({
  verticals: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string().default(''),
        synonyms: z.array(z.string()).default([]),
        /** Точные title гипотез, входящих в вертикаль. */
        member_titles: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});
export type HeClusteringOutput = z.infer<typeof HeClusteringSchema>;
export type HeClusteringDecision = HeClusteringOutput['verticals'][number];

/* ─────────────────────── vocab ─────────────────────── */

export const HeVocabSchema = z.object({
  company_types: z
    .array(
      z.object({
        term: z.string(),
        kind: z.enum(['canonical', 'synonym', 'geo_variant', 'adjacent', 'slang']).default('synonym'),
        geo: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .default([]),
  job_titles: z
    .array(
      z.object({
        title: z.string(),
        /**
         * Сторона аудитории (обязательна):
         * buyer — ЛПР компаний вертикали (кому агентство продаёт);
         * campaign_target — цели будущих кампаний клиентов вертикали.
         */
        audience_side: z.enum(['buyer', 'campaign_target']),
        seniority: z.string().optional(),
        function: z.string().optional(),
        geo: z.string().optional(),
        alt_names: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  search_queries: z
    .array(
      z.object({
        source: z.string(),
        query: z.string(),
        purpose: z.string().optional(),
        /** Служебная пометка (напр. «поиском не подтверждён» после верификации). */
        notes: z.string().optional(),
      }),
    )
    .default([]),
});
export type HeVocabOutput = z.infer<typeof HeVocabSchema>;

/* ─────────────────────── base_analyze ─────────────────────── */

const HeDistributionSchema = z
  .array(z.object({ value: z.string(), share_pct: z.number().min(0).max(100) }))
  .default([]);

export const HeBaseAnalysisSchema = z.object({
  geo_distribution: HeDistributionSchema,
  industry_distribution: HeDistributionSchema,
  company_type_distribution: HeDistributionSchema,
  title_distribution: HeDistributionSchema,
  notable_segments: z.array(z.string()).default([]),
  data_quality_notes: z.string().default(''),
  recommended_angles: z.array(z.string()).default([]),
});
export type HeBaseAnalysisOutput = z.infer<typeof HeBaseAnalysisSchema>;

/* ─────────────────────── template (план 85/15) ─────────────────────── */

/**
 * Условный сегментный вариант письма (~15% дописки под базу). Основной текст
 * письма — дефолт для всей базы; вариант идёт ТОЛЬКО лидам сегмента `when`.
 */
export const HeSegmentVariantSchema = z.object({
  /** Человекочитаемое условие сегмента, отсылающее к анализу базы (напр. «компании вне Москвы/СПб»). */
  when: z.string(),
  /** Текст письма для этого сегмента. */
  text: z.string(),
});
export type HeSegmentVariantOutput = z.infer<typeof HeSegmentVariantSchema>;

export const HeTemplatePlanSchema = z.object({
  /** Фиксированный (~85%) смысловой костяк цепочки под гипотезу. */
  fixed_block: z.string(),
  personalization_plan: z
    .array(
      z.object({
        letter_index: z.number().int().min(1),
        operators: z
          .array(
            z.object({
              var: z.string(),
              column: z.string(),
              fallback: z.string().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  /**
   * Legacy-поле ранних прогонов (безусловные дописки). Сохранено для
   * обратной совместимости схемы; новые планы несут дописки в
   * `letters[].segment_variants` (условные, отдельно от основного текста).
   */
  segment_additions: z
    .array(
      z.object({
        letter_index: z.number().int().min(1),
        addition: z.string(),
        why: z.string().default(''),
      }),
    )
    .default([]),
  /** ~15%: условные сегментные варианты по письмам (основной текст — дефолт). */
  letters: z
    .array(
      z.object({
        letter_index: z.number().int().min(1),
        segment_variants: z.array(HeSegmentVariantSchema).default([]),
      }),
    )
    .default([]),
});
export type HeTemplatePlanOutput = z.infer<typeof HeTemplatePlanSchema>;
