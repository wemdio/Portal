import { z } from 'zod';

/**
 * JSON-схема ответа LLM для Sales AI — 27 вопросов из ТЗ + метаданные.
 *
 * Использование: `callLLMWithSchema(messages, SalesAiAnalysisSchema, ...)`.
 * LLM возвращает объект по этой схеме через response_format: json_object,
 * Zod валидирует; при mismatch — 1 retry, потом throw.
 *
 * Поля q1..q27 — свободный текст (string), т.к. многие ответы содержательные
 * и не сводятся к enum'ам. Числовое поле только manager_score.
 *
 * Правило: если данных для вопроса недостаточно — LLM должен вернуть "unknown"
 * или пустую строку, а НЕ выдумывать. См. system prompt.
 */
export const SalesAiAnalysisSchema = z.object({
  // 27 вопросов из ТЗ
  q1_funnel_stage:                z.string(),
  q2_next_step:                   z.string(),
  q3_loss_risk:                   z.string(),
  q4_script_followed:             z.string(),
  q5_missed_stages:               z.string(),
  q6_dialog_opening:              z.string(),
  q7_unclear_zones:               z.string(),
  q8_offer_to_need_match:         z.string(),
  q9_evidence_used:               z.string(),
  q10_next_step_clarity:          z.string(),
  q11_objections_found:           z.string(),
  q12_objections_handled:         z.string(),
  q13_objections_open:            z.string(),
  q14_pauses_initiative:          z.string(),
  q15_interruptions_templates:    z.string(),
  q16_manager_did_well:           z.string(),
  q17_manager_score_reason:       z.string(),
  q18_top3_strengths:             z.string(),
  q19_top3_growth_zones:          z.string(),
  q20_skill_to_improve:           z.string(),
  q21_source_alignment:           z.string(),
  q22_purchase_probability_up:    z.string(),
  q23_purchase_probability_down:  z.string(),
  q24_next_touch_recommendation:  z.string(),
  q25_win_loss_reason:            z.string(),
  q26_script_improvement:         z.string(),
  q27_grammar_quality:            z.string(),

  // Числовая оценка (шкала 1..10)
  manager_score: z.number().int().min(1).max(10),

  // Управленческие фильтры — дублируются в колонки для быстрых SQL-запросов
  action_type: z.enum(['manager_action_needed', 'no_action_needed']),
  risk_level: z.enum(['low', 'medium', 'high']),
  confidence: z.enum(['low', 'medium', 'high']),

  // Цитаты-доказательства. question — номер вопроса (1..27), к которому evidence привязано.
  evidence: z.array(z.object({
    question: z.number().int().min(1).max(27).nullable(),
    source: z.enum(['chat', 'call', 'amo']),
    quote: z.string().max(500),
    why: z.string(),
  })).default([]),
});

export type SalesAiAnalysis = z.infer<typeof SalesAiAnalysisSchema>;
