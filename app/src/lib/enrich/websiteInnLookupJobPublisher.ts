export type WebsiteInnLookupPublishItem = {
  row_index: number;
  url: string;
};

export type WebsiteInnLookupPreparingJob = {
  id: string;
  total: number;
  [key: string]: unknown;
};

export interface WebsiteInnLookupPublisherDeps<TPublishedJob> {
  createPreparingJob(job: WebsiteInnLookupPreparingJob): Promise<{ id: string }>;
  insertItems(jobId: string, items: WebsiteInnLookupPublishItem[]): Promise<void>;
  countItems(jobId: string): Promise<number>;
  publishJob(jobId: string): Promise<TPublishedJob>;
  failPreparingJob(jobId: string, message: string): Promise<void>;
}

const DEFAULT_CHUNK_SIZE = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Не удалось создать задачу');
}

/**
 * Двухфазная публикация защищает worker от пустой/частичной очереди:
 * status=preparing не claim'ится, затем пишутся все items, сверяется count,
 * и лишь после этого job атомарно переводится в pending.
 */
export async function publishWebsiteInnLookupJob<TPublishedJob>(
  job: WebsiteInnLookupPreparingJob,
  items: WebsiteInnLookupPublishItem[],
  deps: WebsiteInnLookupPublisherDeps<TPublishedJob>,
  options?: { chunkSize?: number },
): Promise<TPublishedJob> {
  if (items.length !== job.total) {
    throw new Error(`Website INN lookup queue mismatch: ${items.length}/${job.total}`);
  }

  const chunkSizeCandidate = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkSize = Number.isFinite(chunkSizeCandidate)
    ? Math.max(1, Math.min(5_000, Math.floor(chunkSizeCandidate)))
    : DEFAULT_CHUNK_SIZE;
  const preparing = await deps.createPreparingJob(job);

  try {
    for (let offset = 0; offset < items.length; offset += chunkSize) {
      await deps.insertItems(preparing.id, items.slice(offset, offset + chunkSize));
    }
    const persisted = await deps.countItems(preparing.id);
    if (persisted !== job.total) {
      throw new Error(`Website INN lookup queue incomplete: ${persisted}/${job.total}`);
    }
    return await deps.publishJob(preparing.id);
  } catch (error) {
    const message = errorMessage(error);
    await deps.failPreparingJob(preparing.id, message.slice(0, 1000));
    throw new Error(message);
  }
}
