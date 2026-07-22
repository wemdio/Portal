export type EnrichmentJobLike = {
  id: string;
  status?: string | null;
};

const ACTIVE_ENRICHMENT_JOB_STATUSES = new Set(['preparing', 'pending', 'running']);

export type EnrichmentQueueCounts = {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
};

export function isActiveEnrichmentJobStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return ACTIVE_ENRICHMENT_JOB_STATUSES.has(status);
}

export function extractActiveJobIds(jobs: EnrichmentJobLike[]): string[] {
  return jobs.filter((job) => isActiveEnrichmentJobStatus(job.status)).map((job) => job.id);
}

export function shouldFinalizeEnrichmentJob(
  expectedTotal: number,
  counts: EnrichmentQueueCounts,
): boolean {
  if (!Number.isFinite(expectedTotal) || expectedTotal < 0) return false;
  if (counts.pending > 0 || counts.processing > 0) return false;

  const terminal = counts.completed + counts.failed + counts.skipped;
  return terminal === expectedTotal;
}
