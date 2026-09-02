import type { VeBaseSummary, VeCollectInfo, VeJobSummary } from './api';

/** JSON counters: missing or malformed is unknown, not zero. */
export function collectCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

export function collectTaskDone(status: string | undefined): boolean {
  return typeof status === 'string' && ['done', 'completed', 'success', 'ok'].includes(status.toLowerCase());
}

export function collectTaskFailed(status: string | undefined): boolean {
  return typeof status === 'string' && ['failed', 'error'].includes(status.toLowerCase());
}

/** All bases of one project, not just the visible vertical. Never mutates API data. */
export function getCollectionQueue(
  bases: readonly VeBaseSummary[],
  jobs: readonly Pick<VeJobSummary, 'stage' | 'status' | 'payload'>[] = [],
) {
  const ordered = bases.filter((base) => base.status === 'collecting').sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const collectingIds = new Set(ordered.map((base) => base.id));
  const blockers = new Set<string>();
  const blocked = new Set<string>();
  for (const base of ordered) {
    const blocker = base.collect_info?.waiting_for_base_id;
    if (typeof blocker === 'string' && blocker !== base.id && collectingIds.has(blocker)) {
      blockers.add(blocker);
      blocked.add(base.id);
    }
  }
  const eligible = ordered.filter((base) => !blocked.has(base.id));
  const activeJobBaseIds = new Set(jobs.filter((job) => job.stage === 'base_collect'
    && (job.status === 'running' || job.status === 'pending')).map((job) => job.payload?.base_id));
  const started = eligible.filter((base) => {
    const info = base.collect_info;
    return info?.construct != null || (Array.isArray(info?.tasks) && info.tasks.length > 0)
      || (Array.isArray(info?.plan?.tasks) && info.plan.tasks.length > 0);
  });
  // Explicit worker evidence beats chronology (an old orphan can still be collecting).
  // The project's last 30 jobs are incomplete, so their absence proves nothing.
  const current = eligible.find((base) => blockers.has(base.id))
    ?? started.find((base) => activeJobBaseIds.has(base.id))
    ?? started[0]
    ?? eligible.find((base) => activeJobBaseIds.has(base.id))
    ?? eligible[0];
  return { current, queued: ordered.filter((base) => base.id !== current?.id) };
}

export function getCollectionProgress(info: VeCollectInfo | null | undefined) {
  const tasks = Array.isArray(info?.tasks) ? info.tasks : [];
  const completedCounts = tasks.filter((task) => task && collectTaskDone(task.status))
    .map((task) => collectCount(task.rows)).filter((count): count is number => count !== null);
  const sourceRows = completedCounts.length ? completedCounts.reduce((sum, count) => sum + count, 0) : null;
  const candidates = collectCount(info?.stats?.rows_total);
  const construct = info?.construct;
  const snapshot = construct?.progress;
  const phase = !construct
    ? (tasks.length > 0 || (Array.isArray(info?.plan?.tasks) && info.plan.tasks.length > 0) ? 'collecting' : 'planning')
    : snapshot?.status === 'pending' ? 'construct_queued'
      : snapshot?.status === 'completed' || construct.status === 'done' ? 'finishing'
        : snapshot?.status === 'failed' || snapshot?.status === 'cancelled' ? 'construct_failed'
          : 'processing';
  const percent = collectCount(snapshot?.current_step_progress);
  const stepPercent = phase === 'processing' && snapshot?.status === 'processing'
    && percent !== null && percent <= 100 ? percent : null;
  return {
    phase, candidates, sourceRows, stepPercent,
    stepKey: typeof snapshot?.current_step_key === 'string' ? snapshot.current_step_key : null,
  } as const;
}
