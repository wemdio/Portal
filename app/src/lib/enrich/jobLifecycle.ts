export type EnrichmentJobLike = {
  id: string;
  status?: string | null;
};

const ACTIVE_ENRICHMENT_JOB_STATUSES = new Set(['pending', 'running']);

export function isActiveEnrichmentJobStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return ACTIVE_ENRICHMENT_JOB_STATUSES.has(status);
}

export function extractActiveJobIds(jobs: EnrichmentJobLike[]): string[] {
  return jobs.filter((job) => isActiveEnrichmentJobStatus(job.status)).map((job) => job.id);
}
