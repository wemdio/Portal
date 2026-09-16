/** Extra slots admit only bounded preview batches; bulk uploads keep their own slot. */
export function constructorPreviewSlots(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(2, parsed) : 0;
}

export function isSmallConstructorJob(job: {
  initial_row_count?: unknown; selected_steps?: unknown; step_config?: unknown;
}): boolean {
  if (!Number.isInteger(job.initial_row_count) || Number(job.initial_row_count) < 1 || Number(job.initial_row_count) > 200
    || !Array.isArray(job.selected_steps) || !job.selected_steps.length) return false;
  if (job.selected_steps.length === 1 && job.selected_steps[0] === 'validate_emails') return true;
  const config = job.step_config as { queue_class?: unknown } | null;
  return config?.queue_class === 'interactive_preview' && job.selected_steps.length <= 5
    && job.selected_steps.every((step) => ['find_emails', 'enrich_descriptions', 'split_emails', 'dedup_email', 'validate_emails'].includes(step));
}

export function constructorAdmission(running: number, bulkRunning: number, bulkSlots: number, previewSlots: number, rss: number, memoryLimit: number): 'any' | 'small' | null {
  if (running > 0 && memoryLimit > 0 && rss >= memoryLimit * 0.65) return null;
  if (bulkRunning < bulkSlots) return 'any';
  if (running >= bulkSlots + previewSlots) return null;
  // Leave room for expanding email rows and checkpoints. Missing cgroup
  // limits disable extra admission, without stopping the normal bulk slot.
  return memoryLimit > 0 && rss < memoryLimit * 0.65 ? 'small' : null;
}

/** A process-wide SMTP ceiling shared by all concurrently running jobs. */
export function createConstructorProbePool(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Constructor probe limit must be a positive integer');
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try { return await work(); }
    finally {
      const next = waiting.shift();
      if (next) next(); // Transfer the occupied slot directly to the next waiter.
      else active--;
    }
  };
}
