/**
 * Стадия base_analyze: читает ve_bases (columns + sample_rows) → LLM-профиль
 * базы (гео/индустрии/типы/должности + сегменты + углы) → ve_bases.analysis,
 * status 'analyzed'. Результат — основа 15% дописки стадии template.
 */

import { callLLMWithSchema, getVeModel } from '../llm';
import { VeBaseAnalysisSchema } from '../schemas';
import { buildBaseAnalysisMessages } from '../prompts/baseAnalyze';
import { buildBaseAnalysisMessagesEn } from '../prompts/baseAnalyze.en';
import { projectMarket } from '../market';
import { moscowDateKey, readStoredRuSeasonality } from '../ruSeasonality';
import type { VeBase, VeJob, VeRuSeasonality } from '../types';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  truncate,
  type VeStageContext,
  type VeStageResult,
} from './shared';

const MAX_SAMPLE_ROWS = 30;
const MAX_CELL_CHARS = 120;

function sanitizeRow(row: Record<string, unknown>, columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const col of columns) {
    const value = row[col];
    if (value == null) continue;
    out[col] = truncate(String(value), MAX_CELL_CHARS);
  }
  return out;
}

export async function runBaseAnalyzeStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');

  const { data: baseRow, error: bError } = await ctx.supabase
    .from('ve_bases')
    .select('*')
    .eq('id', baseId)
    .single();
  if (bError || !baseRow) throw new Error(`ve_bases ${baseId}: ${bError?.message ?? 'not found'}`);
  const base = baseRow as VeBase;

  const columns = Array.isArray(base.columns) ? base.columns : [];
  const sampleRows = (Array.isArray(base.sample_rows) ? base.sample_rows : [])
    .slice(0, MAX_SAMPLE_ROWS)
    .map((r) => sanitizeRow(r, columns));

  await ctx.supabase
    .from('ve_bases')
    .update({ status: 'analyzing', updated_at: new Date().toISOString() })
    .eq('id', baseId);

  let verticalName = '';
  if (base.vertical_id) {
    const { data: vRow } = await ctx.supabase
      .from('ve_verticals')
      .select('name')
      .eq('id', base.vertical_id)
      .maybeSingle();
    verticalName = (vRow as { name?: string } | null)?.name ?? '';
  }

  // Рынок: ctx.market (воркер), фолбэк — колонка ve_projects.market (лениво,
  // только когда воркер рынок не прокинул). Определяет язык промпта анализа.
  const market = ctx.market ?? projectMarket(await readProject(ctx.supabase, job.project_id));
  const now = new Date();
  let verifiedSeasonality: VeRuSeasonality | null = null;
  if (market === 'ru' && base.hypothesis_id) {
    // Best-effort legacy boundary: old hypotheses have no column value.  Only
    // the evidence-stage persisted snapshot may influence seasonal copy.
    const { data: hypothesisRow, error: seasonalityError } = await ctx.supabase
      .from('ve_hypotheses')
      .select('seasonality')
      .eq('id', base.hypothesis_id)
      .maybeSingle();
    if (!seasonalityError && hypothesisRow) {
      const stored = readStoredRuSeasonality(
        (hypothesisRow as { seasonality?: unknown }).seasonality,
      );
      if (stored.classification !== 'unknown') verifiedSeasonality = stored;
    }
  }

  const llm = await callLLMWithSchema(
    (market === 'us' ? buildBaseAnalysisMessagesEn : buildBaseAnalysisMessages)({
      filename: base.filename,
      rowCount: base.row_count,
      columns,
      sampleRows,
      verticalName,
      // RU business timing flips at Moscow midnight (21:00 UTC). The US
      // pipeline keeps its existing UTC date until it has a market timezone.
      today: market === 'ru' ? moscowDateKey(now) : now.toISOString().slice(0, 10),
      // US keeps its previous prompt behavior; RU receives verified v2 data only.
      verifiedSeasonality: market === 'ru' ? verifiedSeasonality : null,
    }),
    VeBaseAnalysisSchema,
    { model: getVeModel('bulk'), maxTokens: 4096 },
  );
  addUsage(usage, llm);

  const { error: updError } = await ctx.supabase
    .from('ve_bases')
    .update({ analysis: llm.data, status: 'analyzed', updated_at: new Date().toISOString() })
    .eq('id', baseId);
  if (updError) throw new Error(`ve_bases update analysis: ${updError.message}`);

  return { result: llm.data, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
