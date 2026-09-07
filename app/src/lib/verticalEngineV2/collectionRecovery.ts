import { isVeProviderBillingError } from './collectionErrors';

/** Only recognized preview failures may reuse a base; never supply/refill. */
export function previewRecoveryKind(base: Record<string, unknown>): 'validation' | 'billing' | null {
  const info = base.collect_info as Record<string, unknown> | null;
  if (base.source !== 'auto' || base.status !== 'failed' || !base.hypothesis_id
    || !info || info.collection_mode !== 'preview' || info.refill || info.supply_batch_id) return null;
  const progress = info.target_progress as Record<string, unknown> | undefined;
  const checkpoint = info.target_checkpoint as Record<string, unknown> | undefined;
  const construct = info.construct as Record<string, unknown> | undefined;
  const stats = info.stats as Record<string, unknown> | undefined;
  const names = info.company_name_cleanup as Record<string, unknown> | undefined;
  if (!progress) return null;
  if (progress.status === 'error' && construct?.status === 'done' && typeof construct.bc_job_id === 'string'
    && checkpoint?.completed_round === progress.round
    && (progress.round === 1 || (typeof checkpoint?.prior_low_relevance === 'number'
      && typeof checkpoint?.prior_relevance_unchecked === 'number'))
    && (stats?.relevance_coverage_complete === false
      || (!!info.company_name_recovery && names?.status === 'partial'))) return 'validation';
  // A failed planner has not committed any candidate round. Reuse its empty
  // base after funds are restored, instead of accumulating duplicate failures.
  if (!construct && !checkpoint && progress.round === 1 && progress.candidates_processed === 0
    && isVeProviderBillingError(base.error ?? progress.reason)) return 'billing';
  return null;
}
