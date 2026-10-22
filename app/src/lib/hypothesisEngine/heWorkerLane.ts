/**
 * Which Hypothesis Engine jobs one worker process takes (HE_WORKER_LANE).
 *
 * One process used to run everything: verified ENG client collections shared
 * its two parallel slots, and every other stage — the RU staff tool's research
 * among them — ran alone. A forty-minute RU research stage therefore stopped
 * every ENG collection behind it. Two processes split the queue:
 *
 * - 'all' (unset): the original single process, unchanged.
 * - 'serial': everything except verified ENG client collections.
 * - 'eng_collections': only verified ENG client collections.
 *
 * Each process returns to the queue only the stuck rows of its own lane on
 * start; otherwise a restart of one would re-queue the other's paid stage in
 * flight. An unknown value refuses to start rather than fall back to 'all':
 * two processes that both take everything would do exactly that.
 */
export type HeWorkerLane = 'all' | 'serial' | 'eng_collections';

export function readHeWorkerLane(env: NodeJS.ProcessEnv = process.env): HeWorkerLane {
  const raw = (env.HE_WORKER_LANE ?? '').trim();
  if (raw === '' || raw === 'all') return 'all';
  if (raw === 'serial' || raw === 'eng_collections') return raw;
  throw new Error(`HE_WORKER_LANE='${raw}' is not one of all, serial, eng_collections`);
}

/** Whether this lane takes (and on start re-queues) a job of this kind. */
export function heWorkerLaneTakes(lane: HeWorkerLane, scope: { parallelEligible: boolean }): boolean {
  if (lane === 'all') return true;
  return lane === 'eng_collections' ? scope.parallelEligible : !scope.parallelEligible;
}
