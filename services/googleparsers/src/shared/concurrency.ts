export async function runConcurrentPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<void> {
  if (items.length === 0) return;

  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.min(items.length, Math.max(1, normalizedConcurrency));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (!shouldStop()) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await task(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
