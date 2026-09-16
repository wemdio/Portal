import { isVeProviderBillingError } from './collectionErrors';

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
  if (base.error === 'Provider usage journal could not be saved.'
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
