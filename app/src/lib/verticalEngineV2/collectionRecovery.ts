import { isVeProviderBillingError } from './collectionErrors';
import { buildVeRelevanceReviewBatch, readVeRelevanceReserve, readVeRelevanceSourceRows } from './relevanceReserve';
import { needsVeSavedEmailReview } from './savedEmailReviewEligibility';
import { isVeRelevanceTriageEnabled } from './relevanceTriageConfig';

/** Explicit continuation only: a terminal partial preview is never daily supply. */
export function canResumePartialPreview(base: Record<string, unknown>): boolean {
  const info = base.collect_info as Record<string, unknown> | null;
  const target = info?.target_progress as Record<string, unknown> | undefined;
  const checkpoint = info?.target_checkpoint as Record<string, unknown> | undefined;
  if (base.source !== 'auto' || base.status !== 'analyzed' || !base.hypothesis_id
    || info?.collection_mode !== 'preview' || info.refill || info.supply_batch_id || !target
    || !['limited', 'exhausted', 'error'].includes(String(target.status))
    || typeof target.ready_rows !== 'number' || !Number.isSafeInteger(target.ready_rows) || target.ready_rows < 0
    || typeof target.ready_target !== 'number' || !Number.isSafeInteger(target.ready_target) || target.ready_target <= 0
    || typeof target.round !== 'number' || !Number.isSafeInteger(target.round) || target.round < 1
    || checkpoint?.completed_round !== target.round
    || target.ready_rows >= target.ready_target) return false;
  const reserve = readVeRelevanceReserve(info.relevance_reserve);
  // Reuse current eligibility rules: completed uncertain checks do not become
  // an unlimited paid loop merely because fewer than 500 contacts were found.
  // With the calibrated triage enabled, saved uncertainty it has not read yet is
  // resumable work as well: one cheap pass per company, no sources or search.
  if (reserve.some(needsVeSavedEmailReview) || buildVeRelevanceReviewBatch({
    reserve, ready: [], source: readVeRelevanceSourceRows(info.relevance_reserve), automatic: true,
    triage: isVeRelevanceTriageEnabled(typeof base.project_id === 'string' ? base.project_id : null),
  }).rows.length > 0) return true;
  return Number(target.candidates_processed) < Number(target.max_candidates)
    && Number(target.round) < Number(target.max_rounds)
    && Array.isArray(info.tasks) && info.tasks.some((task) =>
      task && (task.status === 'pending' || task.status === 'dispatched'
        || (task.status === 'done' && (task.source === 'companies_directory' || task.catalog)
          && !task.exhausted && !task.hit_ceiling)));
}

/** Only recognized preview failures may reuse a base; never supply/refill. */
export function previewRecoveryKind(base: Record<string, unknown>): 'validation' | 'billing' | 'pipeline' | 'discovery' | 'catalog' | 'interrupted' | null {
  const info = base.collect_info as Record<string, unknown> | null;
  if (base.source !== 'auto' || base.status !== 'failed' || !base.hypothesis_id
    || !info || info.collection_mode !== 'preview' || info.refill || info.supply_batch_id) return null;
  const progress = info.target_progress as Record<string, unknown> | undefined;
  const checkpoint = info.target_checkpoint as Record<string, unknown> | undefined;
  const construct = info.construct as Record<string, unknown> | undefined;
  const stats = info.stats as Record<string, unknown> | undefined;
  const names = info.company_name_cleanup as Record<string, unknown> | undefined;
  if (!progress) return null;
  // Accounting failures stop paid work immediately, possibly between rounds.
  // An explicit continuation must reuse the durable children/cursors instead
  // of purchasing a new base. Reject incoherent checkpoints and cancellations.
  // Exhausted 429 waits fail the job with the round still `collecting`; the
  // saved checkpoint is coherent and must be continued, not replaced by a new
  // paid base (18.09.2026: five bases). Same rule as the journal outage.
  // The inactivity watchdog (19.09.2026) fails the same way after its retries:
  // the round is still `collecting` and every checkpoint is intact.
  if ((base.error === 'Provider usage journal could not be saved.'
    || /^(?:Requesty 429|VE2 [a-z_]+ inactivity timeout)\b/.test(String(base.error ?? '')))
    && progress.status === 'collecting'
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && (checkpoint?.completed_round ?? 0) === progress.round
      - (info.validation_retry || info.company_name_recovery || info.relevance_review_requested ? 0 : 1)) return 'interrupted';
  const discovery = info.source_contact_recovery as Record<string, unknown> | undefined;
  if (progress.status === 'error' && !construct && discovery?.version === 1
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && (checkpoint?.completed_round ?? 0) === progress.round - 1) return 'discovery';
  const pipeline = info.preview_pipeline as Record<string, unknown> | undefined;
  if (progress.status === 'error' && pipeline?.version === 1 && Array.isArray(pipeline.batches)
    && typeof pipeline.revision === 'number' && Number.isSafeInteger(pipeline.revision)
    && typeof progress.round === 'number' && Number.isSafeInteger(progress.round) && progress.round > 0
    && (checkpoint?.completed_round === progress.round
      || (pipeline.batches.length > 0 && (checkpoint?.completed_round ?? 0) === progress.round - 1))) return 'pipeline';
  if (progress.status === 'error' && construct?.status === 'done' && typeof construct.bc_job_id === 'string'
    && typeof progress.round === 'number' && Number.isInteger(progress.round) && progress.round > 0
    && checkpoint?.completed_round === progress.round
    // Older multi-round previews lack prior_* diagnostic counters. Recovery
    // uses the completed constructor and saved recipients, not those counters.
    // Requiring them would silently start and pay for a new collection.
    && (stats?.relevance_coverage_complete === false
      || base.error === 'Проверка email завершилась не полностью'
      || (!!info.company_name_recovery && names?.status === 'partial'))) return 'validation';
  // A failed planner has not committed any candidate round. Reuse its empty
  // base after funds are restored, instead of accumulating duplicate failures.
  if (!construct && !checkpoint && progress.round === 1 && progress.candidates_processed === 0
    && isVeProviderBillingError(base.error ?? progress.reason)) return 'billing';
  if (progress.status === 'error' && Array.isArray(info.tasks) && info.tasks.some((task) =>
    task?.source === 'yandex_maps' && task.status === 'failed' && task.task?.maps_query?.queries?.length)) return 'catalog';
  return null;
}
