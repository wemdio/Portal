import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeJob } from './types';

/**
 * Ready-time FIFO: a cooperative yield puts the same durable job behind work
 * already waiting, instead of its original created_at reclaiming the worker.
 * Failure retries and parser polling keep their existing run_after cooldown.
 */
export async function claimVeJob(db: SupabaseClient, now = new Date(), activeProjects: readonly string[] = []): Promise<VeJob | null> {
  const nowIso = now.toISOString();
  let query = db.from('ve_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('run_after', nowIso);
  for (const projectId of activeProjects) query = query.neq('project_id', projectId);
  const { data: pending, error: readError } = await query
    .order('run_after', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (readError) throw new Error(`ve_jobs queue read: ${readError.message}`);
  if (!pending) return null;

  // attempts counts failures, not claims: evidence slices and base polling can
  // claim the same job many times without consuming the provider retry budget.
  const { data: claimed, error: claimError } = await db.from('ve_jobs')
    .update({ status: 'running', started_at: nowIso, updated_at: nowIso })
    .eq('id', (pending as VeJob).id)
    .eq('status', 'pending')
    .lte('run_after', nowIso)
    .select('*')
    .maybeSingle();
  if (claimError) throw new Error(`ve_jobs queue claim: ${claimError.message}`);
  return (claimed as VeJob | null) ?? null;
}

/** One process owns the queue. Parallelize projects, never stages of one project. */
export function createVeJobPool(options: {
  concurrency: number;
  idleMs: number;
  shouldStop: () => boolean;
  claim: (activeProjects: string[]) => Promise<VeJob | null>;
  run: (job: VeJob) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 2) {
    throw new Error('VE2 job concurrency must be 1 or 2');
  }
  const active = new Map<string, Promise<void>>();
  const settle = async (idleMs?: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([...active.values(), ...(idleMs === undefined ? [] : [
        new Promise<void>((resolve) => { timer = setTimeout(resolve, idleMs); }),
      ])]);
    } finally { clearTimeout(timer); }
  };
  return {
    // Called serially by pollLoop; claims cannot race the active-project map.
    async pollOnce(): Promise<boolean> {
      if (options.shouldStop()) return false;
      if (active.size >= options.concurrency) { await settle(); return true; }
      const job = await options.claim([...active.keys()]);
      // A claim interrupted by shutdown is recovered by the next worker startup.
      if (options.shouldStop()) return false;
      if (!job) {
        if (!active.size) return false;
        await settle(options.idleMs);
        return true;
      }
      if (active.has(job.project_id)) throw new Error('VE2 claimed a second active job for one project');
      const pending = Promise.resolve().then(() => options.run(job))
        .catch(options.onError).finally(() => { active.delete(job.project_id); });
      active.set(job.project_id, pending);
      return true;
    },
    async drain() { await Promise.all(active.values()); },
  };
}
