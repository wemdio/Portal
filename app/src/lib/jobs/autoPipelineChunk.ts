export interface AutoPipelineChunkCompletion<T> {
  index: number;
  value: T;
}

export interface AutoPipelineChunkOutcome<T> {
  completed: AutoPipelineChunkCompletion<T>[];
  interrupted: boolean;
}

/**
 * Once shutdown interrupts a sequence of provider appends, rows that needed an
 * untouched append must remain absent from durable seen/snapshot storage so a
 * later run can retry them. Rows without a provider side effect, plus rows from
 * append calls that actually finished, are safe to persist.
 */
export function retainRowsSafeAfterInterruptedAppend<T>({
  rows,
  getEmployerId,
  appendCandidateEmployerIds,
  completedAppendEmployerIds,
}: {
  rows: readonly T[];
  getEmployerId: (row: T) => string;
  appendCandidateEmployerIds: ReadonlySet<string>;
  completedAppendEmployerIds: ReadonlySet<string>;
}): T[] {
  return rows.filter((row) => {
    const employerId = getEmployerId(row);
    return (
      !appendCandidateEmployerIds.has(employerId) ||
      completedAppendEmployerIds.has(employerId)
    );
  });
}

export async function waitForAutoPipelineDelay({
  delayMs,
  shouldStop,
  pollIntervalMs = 1_000,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  delayMs: number;
  shouldStop?: () => boolean;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  if (delayMs <= 0) return Boolean(shouldStop?.());
  if (!shouldStop) {
    await sleep(delayMs);
    return false;
  }

  let remainingMs = delayMs;
  const sliceMs = Math.max(1, Math.floor(pollIntervalMs));
  while (remainingMs > 0) {
    if (shouldStop()) return true;
    const currentSlice = Math.min(sliceMs, remainingMs);
    await sleep(currentSlice);
    remainingMs -= currentSlice;
  }
  return shouldStop();
}

/**
 * Runs a bounded worker pool and stops assigning new items as soon as a
 * graceful-shutdown signal is observed. Work that was already in flight is
 * allowed to finish and is returned to the caller for durable persistence.
 */
export async function mapAutoPipelineChunkUntilStopped<TInput, TOutput>({
  items,
  concurrency,
  shouldStop,
  process,
}: {
  items: readonly TInput[];
  concurrency: number;
  shouldStop?: () => boolean;
  process: (item: TInput, index: number) => Promise<TOutput>;
}): Promise<AutoPipelineChunkOutcome<TOutput>> {
  const completedSlots: Array<AutoPipelineChunkCompletion<TOutput> | undefined> =
    new Array(items.length);
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(concurrency)),
  );
  let cursor = 0;
  let interrupted = false;

  async function worker(): Promise<void> {
    while (true) {
      if (cursor >= items.length) return;
      if (shouldStop?.()) {
        interrupted = true;
        return;
      }

      const index = cursor;
      cursor += 1;

      const value = await process(items[index], index);
      completedSlots[index] = { index, value };
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const completed = completedSlots.slice(0, cursor);
  if (completed.some((entry) => entry === undefined)) {
    throw new Error('Auto-pipeline cooperative map completed with a missing result');
  }

  return {
    completed: completed as AutoPipelineChunkCompletion<TOutput>[],
    interrupted,
  };
}
