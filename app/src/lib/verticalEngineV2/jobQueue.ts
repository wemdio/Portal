import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeJob } from './types';

export const VE_MAX_JOB_CONCURRENCY = 16;
export function veJobConcurrency(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, VE_MAX_JOB_CONCURRENCY) : 8;
}

const BASE_STAGES = new Set(['base_collect', 'base_analyze', 'template']);
const COLLECT_STAGE = 'base_collect';

/** Collection shares the normal pool by default. Paid searches have their own
 * capacity/circuit breaker; waiting for SMTP or reading a catalog must not
 * occupy a separate three-base bottleneck. The override remains available for
 * an explicit operational throttle. Both limits are per worker process. */
export const VE_DEFAULT_BASE_COLLECT_CONCURRENCY = VE_MAX_JOB_CONCURRENCY;
export function veBaseCollectConcurrency(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1
    ? Math.min(parsed, VE_MAX_JOB_CONCURRENCY) : VE_DEFAULT_BASE_COLLECT_CONCURRENCY;
}
type JobScope = Pick<VeJob, 'id' | 'project_id' | 'stage' | 'payload'>;
const baseKey = (job: JobScope): string | null => BASE_STAGES.has(job.stage)
  && typeof job.payload?.base_id === 'string' && job.payload.base_id.trim() ? job.payload.base_id : null;

/** Активные сборки, посчитанные по базам: одна база не занимает два слота. */
function collectingBases(active: readonly JobScope[]): Set<string> {
  return new Set(active.filter((other) => other.stage === COLLECT_STAGE).map((other) => baseKey(other) ?? other.id));
}

export function canRunVeJob(
  job: JobScope,
  active: readonly JobScope[],
  collectLimit = veBaseCollectConcurrency(process.env.VE_BASE_COLLECT_CONCURRENCY),
): boolean {
  if (job.stage === COLLECT_STAGE) {
    const bases = collectingBases(active);
    if (!bases.has(baseKey(job) ?? job.id) && bases.size >= collectLimit) return false;
  }
  const siblings = active.filter((other) => other.project_id === job.project_id);
  if (!siblings.length) return true;
  const base = baseKey(job);
  return Boolean(base) && siblings.length < 4 && siblings.every((other) => baseKey(other) && baseKey(other) !== base);
}

/** Ready-time FIFO, with exclusive research and independent per-base writers. */
export async function claimVeJob(
  db: SupabaseClient,
  now = new Date(),
  active: readonly JobScope[] = [],
  collectLimit = veBaseCollectConcurrency(process.env.VE_BASE_COLLECT_CONCURRENCY),
): Promise<VeJob | null> {
  const nowIso = now.toISOString();
  // Слоты сборки заняты — не тянем такие строки из БД вовсе, иначе каждый
  // опрос листал бы всю очередь только чтобы отбросить их в памяти.
  const collectFull = collectingBases(active).size >= collectLimit;
  const blocked = new Set(active.filter((job) => !baseKey(job)).map((job) => job.project_id));
  for (const job of active) if (active.filter((other) => other.project_id === job.project_id).length >= 4) blocked.add(job.project_id);
  let pending: JobScope | undefined;
  // Project-exclusive work waiting behind active bases forms a barrier: new
  // base jobs cannot indefinitely bypass that older research/manual operation.
  for (let offset = 0; !pending;) {
    let query = db.from('ve_jobs').select('id,project_id,stage,payload')
      .eq('status', 'pending').lte('run_after', nowIso);
    if (collectFull) query = query.neq('stage', COLLECT_STAGE);
    for (const projectId of blocked) query = query.neq('project_id', projectId);
    const { data, error } = await query.order('run_after', { ascending: true })
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + 99);
    if (error) throw new Error(`ve_jobs queue read: ${error.message}`);
    if (!data?.length) return null;
    const previousBlocked = blocked.size;
    for (const candidate of data as JobScope[]) {
      if (blocked.has(candidate.project_id)) continue;
      if (canRunVeJob(candidate, active, collectLimit)) { pending = candidate; break; }
      if (!baseKey(candidate)) blocked.add(candidate.project_id);
    }
    if (pending) break;
    if (blocked.size !== previousBlocked) offset = 0;
    else if (data.length < 100) return null;
    else offset += data.length;
  }

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

/** One process owns the queue; base stages share a base lock, research a project lock. */
export function createVeJobPool(options: {
  concurrency: number;
  // Лимит одновременных сборок баз. Обязан совпадать с тем, с которым считает
  // claim: иначе пул отвергает как конфликт то, что очередь честно выдала.
  collectLimit?: number;
  idleMs: number;
  shouldStop: () => boolean;
  claim: (activeJobs: JobScope[]) => Promise<VeJob | null>;
  run: (job: VeJob) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > VE_MAX_JOB_CONCURRENCY) {
    throw new Error('VE2 job concurrency must be between 1 and 16');
  }
  const collectLimit = options.collectLimit ?? veBaseCollectConcurrency(process.env.VE_BASE_COLLECT_CONCURRENCY);
  const active = new Map<string, { job: VeJob; promise: Promise<void> }>();
  const settle = async (idleMs?: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([...Array.from(active.values(), (item) => item.promise), ...(idleMs === undefined ? [] : [
        new Promise<void>((resolve) => { timer = setTimeout(resolve, idleMs); }),
      ])]);
    } finally { clearTimeout(timer); }
  };
  return {
    // Called serially by pollLoop; claims cannot race the active scope map.
    async pollOnce(): Promise<boolean> {
      if (options.shouldStop()) return false;
      if (active.size >= options.concurrency) { await settle(); return true; }
      const scopes = Array.from(active.values(), (item) => item.job);
      const job = await options.claim(scopes);
      // A claim interrupted by shutdown is recovered by the next worker startup.
      if (options.shouldStop()) return false;
      if (!job) {
        if (!active.size) return false;
        await settle(options.idleMs);
        return true;
      }
      if (!canRunVeJob(job, scopes, collectLimit)) throw new Error('VE2 claimed a conflicting job scope');
      const pending = Promise.resolve().then(() => options.run(job))
        .catch(options.onError).finally(() => { active.delete(job.id); });
      active.set(job.id, { job, promise: pending });
      return true;
    },
    async drain() { await Promise.all(Array.from(active.values(), (item) => item.promise)); },
  };
}

/** Serialize only the short aggregate write; paid base work stays parallel. */
export function createVeProjectUsageAccumulator(db: SupabaseClient) {
  const pending = new Map<string, Promise<void>>();
  return (projectId: string, tokensUsed: number, costUsd: number): Promise<void> => {
    if (!tokensUsed && !costUsd) return Promise.resolve();
    const task = (pending.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const { data: project, error } = await db.from('ve_projects').select('tokens_used,cost_usd').eq('id', projectId)
        .abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
      if (error) throw new Error(`VE usage aggregate read: ${error.message}`);
      if (!project) return;
      const { error: writeError } = await db.from('ve_projects').update({
        tokens_used: (project.tokens_used ?? 0) + tokensUsed,
        cost_usd: Number(project.cost_usd ?? 0) + costUsd,
        updated_at: new Date().toISOString(),
      }).eq('id', projectId).abortSignal(AbortSignal.timeout(10_000));
      if (writeError) throw new Error(`VE usage aggregate write: ${writeError.message}`);
    });
    pending.set(projectId, task);
    const cleanup = () => { if (pending.get(projectId) === task) pending.delete(projectId); };
    void task.then(cleanup, cleanup);
    return task;
  };
}
