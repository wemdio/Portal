export type BriefScoringJobLike = {
  id: string;
  status?: string | null;
};

const ACTIVE_BRIEF_SCORING_JOB_STATUSES = new Set(['pending', 'running']);

export function isActiveBriefScoringJobStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return ACTIVE_BRIEF_SCORING_JOB_STATUSES.has(status);
}

export function extractActiveBriefScoringJobIds(jobs: BriefScoringJobLike[]): string[] {
  return jobs.filter((job) => isActiveBriefScoringJobStatus(job.status)).map((job) => job.id);
}

