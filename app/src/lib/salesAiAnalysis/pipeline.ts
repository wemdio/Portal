/**
 * Оркестрация анализа одной сделки:
 * 1) собрать контекст (linker + chat + transcripts)
 * 2) посчитать input_hash, если такой уже был для этой сделки — skip
 * 3) вызвать LLM с 27 вопросами → JSON по SalesAiAnalysisSchema
 * 4) записать sales_ai_deal_analysis + sales_ai_evidence
 *
 * Возвращает finalStatus для sales_ai_analysis_jobs.status:
 *  - 'done'    — успех
 *  - 'skipped' — дедуп или нет контекста
 *  - 'failed'  — LLM/DB упало (детали в err)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildContext } from './contextBuilder';
import { syncRegulation, type ActiveRegulation } from './regulation';
import { computeInputHash } from './hasher';
import { callLLMWithSchema, LLMValidationError, type LLMMessage } from './llm';
import { SalesAiAnalysisSchema, type SalesAiAnalysis } from './schemas';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts';

const DEFAULT_MODEL = process.env.SALES_AI_LLM_MODEL || 'claude-haiku-4-5';

export interface PipelineResult {
  status: 'done' | 'skipped' | 'failed';
  skip_reason?: 'no_context' | 'no_new_data';
  error_message?: string;
  analysis_id?: string;
}

export async function runPipeline(
  db: SupabaseClient,
  amoLeadId: number,
  opts: { regulation?: ActiveRegulation } = {},
): Promise<PipelineResult> {
  const regulation = opts.regulation ?? (await syncRegulation(db));

  const ctx = await buildContext(db, amoLeadId);
  if (!ctx) {
    return { status: 'failed', error_message: `lead ${amoLeadId} not found` };
  }
  // Ничего кроме AMO-карточки нет — не тратим токены зря.
  if (!ctx.chatText && !ctx.transcriptText) {
    return { status: 'skipped', skip_reason: 'no_context' };
  }

  const inputHash = computeInputHash({
    amoUpdatedAt: ctx.lead.updated_at,
    lastMessageAt: ctx.lastMessageAt,
    lastTranscriptAt: ctx.lastTranscriptAt,
    regulationSha256: regulation.body_sha256,
  });

  const { data: existing } = await db
    .from('sales_ai_deal_analysis')
    .select('id')
    .eq('amo_lead_id', amoLeadId)
    .eq('input_hash', inputHash)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return { status: 'skipped', skip_reason: 'no_new_data' };
  }

  const userPrompt = buildUserPrompt({
    amo: ctx.amoText,
    chat: ctx.chatText,
    transcripts: ctx.transcriptText,
    regulation: regulation.body,
  });
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let llm;
  try {
    llm = await callLLMWithSchema(messages, SalesAiAnalysisSchema, {
      model: DEFAULT_MODEL,
      // 27 полей + evidence на русском (BPE-токены кириллицы в 3-5× дороже
      // латиницы) — 4096 обрубает JSON посередине. 8192 хватает с запасом,
      // Haiku 4.5 держит output до 64K; худший case = $0.04/сделку.
      maxTokens: 8192,
    });
  } catch (err) {
    const msg = err instanceof LLMValidationError
      ? `LLM invalid JSON: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    return { status: 'failed', error_message: msg.slice(0, 500) };
  }

  const analysis: SalesAiAnalysis = llm.data;

  const { data: inserted, error: insErr } = await db
    .from('sales_ai_deal_analysis')
    .insert({
      amo_lead_id: amoLeadId,
      regulation_id: regulation.id,
      action_type: analysis.action_type,
      manager_score: analysis.manager_score,
      risk_level: analysis.risk_level,
      confidence: analysis.confidence,
      analysis_json: analysis,
      context_messages_count: ctx.chatCount,
      context_transcripts_count: ctx.transcriptCount,
      input_hash: inputHash,
      llm_model: DEFAULT_MODEL,
      tokens_used: llm.tokensUsed,
      cost_usd: llm.costUsd,
    })
    .select('id')
    .single();

  if (insErr || !inserted) {
    return { status: 'failed', error_message: `insert analysis: ${insErr?.message ?? 'unknown'}` };
  }
  const analysisId = (inserted as { id: string }).id;

  if (analysis.evidence.length > 0) {
    const rows = analysis.evidence.map((e) => ({
      analysis_id: analysisId,
      question_num: e.question ?? null,
      source_type: e.source,
      source_id: null,
      quote: e.quote,
      why_relevant: e.why,
    }));
    const { error: evErr } = await db.from('sales_ai_evidence').insert(rows);
    if (evErr) {
      // Evidence — не блокирующее; логируем в error_message, но статус done.
      return { status: 'done', analysis_id: analysisId, error_message: `evidence insert: ${evErr.message}` };
    }
  }

  return { status: 'done', analysis_id: analysisId };
}
