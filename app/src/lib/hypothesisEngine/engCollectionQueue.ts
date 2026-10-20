/** Admission for one HE worker process. Only verified ENG collections may
 * share its two slots; the caller verifies ownership and keeps each active
 * reservation until execution and finalization have both finished. */
export interface HeEngCollectionScope {
  id: string;
  project_id: string;
  baseId: string | null;
  verticalId: string | null;
  parallelEligible: boolean;
}

export interface HeEngCollectionQueueOptions {
  slots?: number;
  /** A stranded finalization blocks its project, not the entire queue. */
  blockedProjectIds?: ReadonlySet<string>;
}

export const HE_ENG_COLLECTION_CONCURRENCY = 2;

function capacity(options: HeEngCollectionQueueOptions): number {
  if (options.slots === undefined) return HE_ENG_COLLECTION_CONCURRENCY;
  return Number.isInteger(options.slots) && options.slots > 0
    ? Math.min(options.slots, HE_ENG_COLLECTION_CONCURRENCY)
    : 1;
}

function hasParallelScope(job: HeEngCollectionScope): job is HeEngCollectionScope & { baseId: string; verticalId: string } {
  return job.parallelEligible === true
    && typeof job.id === 'string' && job.id.trim().length > 0
    && typeof job.project_id === 'string' && job.project_id.trim().length > 0
    && typeof job.baseId === 'string' && job.baseId.trim().length > 0
    && typeof job.verticalId === 'string' && job.verticalId.trim().length > 0;
}

export function canRunHeEngCollection(
  candidate: HeEngCollectionScope,
  active: readonly HeEngCollectionScope[],
  options: HeEngCollectionQueueOptions = {},
): boolean {
  if (options.blockedProjectIds?.has(candidate.project_id)) return false;
  if (active.length >= capacity(options)) return false;
  if (active.some((other) => other.id === candidate.id)) return false;
  if (active.length === 0) return true;
  if (!hasParallelScope(candidate)) return false;
  return active.every((other) => hasParallelScope(other)
    && other.baseId.trim() !== candidate.baseId.trim()
    && other.verticalId.trim() !== candidate.verticalId.trim());
}

/** Candidates must arrive in queue order. An older serial operation is a
 * barrier while collections are running, so new ENG work cannot starve RU,
 * research or other exclusive stages. A blocked project's rows may be skipped
 * even when serial: only recovery can unblock them, not draining this pool. */
export function selectHeEngCollectionCandidate<T extends HeEngCollectionScope>(
  orderedCandidates: readonly T[],
  active: readonly HeEngCollectionScope[],
  options: HeEngCollectionQueueOptions = {},
): T | null {
  if (active.length >= capacity(options)) return null;
  for (const candidate of orderedCandidates) {
    if (options.blockedProjectIds?.has(candidate.project_id)) continue;
    if (canRunHeEngCollection(candidate, active, options)) return candidate;
    if (!hasParallelScope(candidate)) return null;
  }
  return null;
}
