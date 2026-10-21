/**
 * Диспетчер стадий «Движка вертикалей»: воркер клеймит he_jobs-строку и
 * вызывает runHeStage(job, ctx). Контракт контекста/результата объявлен в
 * shared.ts и реэкспортирован здесь (единая точка входа).
 */

import type { HeJob } from '../types';
import type { HeStageContext, HeStageResult } from './shared';
import { runSiteProfileStage } from './siteProfile';
import { runCompetitorsStage } from './competitors';
import { runBrandCloudStage } from './brandCloud';
import { runHypothesesStage } from './hypotheses';
import { runEvidenceStage } from './evidence';
import { runClusteringStage } from './clustering';
import { runChainStage } from './chain';
import { runVocabStage } from './vocab';
import { runBaseAnalyzeStage } from './baseAnalyze';
import { runBaseCollectStage, finishHeEngTargetBudgetStop } from './baseCollect';
import { runTemplateStage } from './template';
import { runDossierStage } from './dossier';
import { readHeEngBaseFirst } from '../engBaseFirst';
import { withHeEngBaseBudget } from '../engBaseBudget';
import { HE_ENG_BASE_BUDGET_MICROUSD, HeEngBaseBudgetError, isHeEngBaseBudgetError } from '../engBaseBudgetLedger';

export type { HeStageContext, HeStageResult } from './shared';

function collectionBudgetStopReason(error: unknown): 'budget_limit' | 'error' | null {
  if (!isHeEngBaseBudgetError(error)) return null;
  let reason: 'budget_limit' | 'error' = 'error';
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof HeEngBaseBudgetError) {
      // Broken or missing accounting is an operational failure, not a finished
      // collection. Keep its safe diagnostic on the ordinary worker fail path.
      if (current.reason === 'missing_history' || current.reason === 'invalid_ledger') return null;
      if (current.reason === 'budget_exhausted') reason = 'budget_limit';
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return reason;
}

/** A later tick may meet a real held ledger before the paid scope can open. */
async function hasStoppedCollectionBudget(
  ctx: HeStageContext, baseId: string, projectId: string, error: unknown,
): Promise<boolean> {
  if (!(error instanceof HeEngBaseBudgetError) ||
      !['budget_exhausted', 'unknown_cost'].includes(error.reason)) return false;
  try {
    const { data: ledger, error: readError } = await ctx.supabase.from('he_eng_base_budgets')
      .select('base_id, project_id, limit_microusd, actual_microusd, reserved_microusd, hold_reason')
      .eq('base_id', baseId).eq('project_id', projectId).maybeSingle();
    if (readError || !ledger || ledger.base_id !== baseId || ledger.project_id !== projectId ||
        ledger.limit_microusd !== HE_ENG_BASE_BUDGET_MICROUSD ||
        !Number.isSafeInteger(ledger.actual_microusd) || ledger.actual_microusd < 0 ||
        !Number.isSafeInteger(ledger.reserved_microusd) || ledger.reserved_microusd < 0 ||
        ledger.actual_microusd + ledger.reserved_microusd <= 0 ||
        ledger.actual_microusd + ledger.reserved_microusd > HE_ENG_BASE_BUDGET_MICROUSD) return false;
    if (ledger.hold_reason === error.reason) return true;
    if (error.reason !== 'unknown_cost' || ledger.hold_reason !== null || ledger.reserved_microusd <= 0) return false;
    // begin also maps pending_spend to unknown_cost. Require an actual unresolved
    // request, without releasing it or pretending its eventual price is zero.
    const { data: pending, error: pendingError } = await ctx.supabase.from('he_eng_base_spend_requests')
      .select('reserved_microusd, status').eq('base_id', baseId)
      .in('status', ['reserved', 'unknown']).limit(1).maybeSingle();
    return !pendingError && !!pending && ['reserved', 'unknown'].includes(pending.status) &&
      Number.isSafeInteger(pending.reserved_microusd) && pending.reserved_microusd > 0 &&
      pending.reserved_microusd <= ledger.reserved_microusd;
  } catch {
    // A second read failure must not replace the original safe budget error.
    return false;
  }
}

export async function runHeStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  // One durable budget follows a base across worker ticks and into its letters.
  // Staff/RU work retains its existing dispatch; a US market alone is not ENG.
  if (ctx.market === 'us' &&
      (job.stage === 'base_collect' || job.stage === 'base_analyze' || job.stage === 'template')) {
    const { data: project, error } = await ctx.supabase.from('he_projects')
      .select('market, created_by').eq('id', job.project_id).maybeSingle();
    if (error || !project) throw new HeEngBaseBudgetError('unavailable');
    if (await readHeEngBaseFirst(ctx.supabase, project)) {
      const baseId = job.payload?.base_id;
      if (typeof baseId !== 'string' || !baseId) throw new HeEngBaseBudgetError('missing_history');
      let budgetOpened = false;
      try {
        return await withHeEngBaseBudget(
          ctx.supabase, baseId, job.project_id, () => {
            budgetOpened = true;
            return dispatchHeStage(job, ctx);
          }, job.stage,
        );
      } catch (error) {
        // Publish only previously checked waves after a terminal money guard.
        // A refused initial begin must never manufacture a successful job.
        // No providers, reservation releases or budget resets run here.
        const reason = job.stage === 'base_collect' ? collectionBudgetStopReason(error) : null;
        if (reason && (budgetOpened || await hasStoppedCollectionBudget(ctx, baseId, job.project_id, error))) {
          const result = await finishHeEngTargetBudgetStop(job, ctx, reason);
          if (result) return result;
        }
        throw error;
      }
    }
  }
  return dispatchHeStage(job, ctx);
}

async function dispatchHeStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  switch (job.stage) {
    case 'site_profile':
      return runSiteProfileStage(job, ctx);
    case 'competitors':
      return runCompetitorsStage(job, ctx);
    case 'brand_cloud':
      return runBrandCloudStage(job, ctx);
    case 'hypotheses':
      return runHypothesesStage(job, ctx);
    case 'evidence':
      return runEvidenceStage(job, ctx);
    case 'clustering':
      return runClusteringStage(job, ctx);
    case 'chain':
      return runChainStage(job, ctx);
    case 'vocab':
      return runVocabStage(job, ctx);
    case 'base_analyze':
      return runBaseAnalyzeStage(job, ctx);
    case 'base_collect':
      return runBaseCollectStage(job, ctx);
    case 'template':
      return runTemplateStage(job, ctx);
    case 'dossier':
      return runDossierStage(job, ctx);
    default: {
      const neverStage: never = job.stage;
      throw new Error(`Неизвестная стадия hypothesis engine: ${String(neverStage)}`);
    }
  }
}

export { runSiteProfileStage } from './siteProfile';
export { runCompetitorsStage } from './competitors';
export { runBrandCloudStage } from './brandCloud';
export { runHypothesesStage } from './hypotheses';
export { runEvidenceStage } from './evidence';
export { runClusteringStage, applyClusteringDecisions } from './clustering';
export type { AppliedVertical, ClusterHypothesisInput } from './clustering';
export { runChainStage, parsedToChainLetters, CHAIN_WAIT_DAYS } from './chain';
export { runVocabStage } from './vocab';
export { runBaseAnalyzeStage } from './baseAnalyze';
export { runBaseCollectStage } from './baseCollect';
export {
  runTemplateStage,
  extractPersonalizationOperators,
  mapOperatorsToColumns,
} from './template';
export { runDossierStage } from './dossier';
