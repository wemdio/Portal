import { findByInn, hasDadataKey } from '@/lib/enrich/dadataClient';
import { fetchInnFromWebsite } from '@/lib/enrich/websiteParser';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { applyWebsiteInnLookupResults } from '@/lib/spreadsheet/applyJobResults';
import type { WebsiteInnLookupResult } from './websiteInnLookupShared';

const SITE_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_SIZE = 5;
const APPLY_RESULTS_INTERVAL = 100;

export type WebsiteInnLookupJob = {
  id: string;
  user_id: string;
  status: string;
  tab_id: string;
  url_column: number;
  inn_column: number;
  company_column: number;
  total: number;
  processed: number;
  found: number;
};

export type WebsiteInnLookupPendingItem = {
  id: string;
  row_index: number;
  url: string;
};

export type WebsiteInnLookupProgress = {
  processed: number;
  found: number;
};

export interface WebsiteInnLookupRunnerDeps {
  loadJob(jobId: string): Promise<WebsiteInnLookupJob | null>;
  isCancellationRequested(jobId: string): Promise<boolean>;
  listPendingItems(jobId: string, limit: number): Promise<WebsiteInnLookupPendingItem[]>;
  lookupItems(items: WebsiteInnLookupPendingItem[]): Promise<WebsiteInnLookupResult[]>;
  persistOutcomes(
    job: WebsiteInnLookupJob,
    outcomes: WebsiteInnLookupResult[],
    current: WebsiteInnLookupProgress,
  ): Promise<WebsiteInnLookupProgress>;
  applyResults(job: WebsiteInnLookupJob): Promise<boolean>;
  completeJob(job: WebsiteInnLookupJob, progress: WebsiteInnLookupProgress): Promise<void>;
  cancelJob(job: WebsiteInnLookupJob, progress: WebsiteInnLookupProgress): Promise<void>;
  failJob(
    job: WebsiteInnLookupJob,
    message: string,
    progress: WebsiteInnLookupProgress,
  ): Promise<void>;
}

/**
 * Возобновляемое ядро worker'а. Browser state здесь намеренно отсутствует:
 * источником истины служат pending items в БД, поэтому закрытие вкладки не
 * влияет на цикл, а рестарт worker'а продолжает только незавершённые строки.
 */
export async function executeWebsiteInnLookupJob(
  jobId: string,
  deps: WebsiteInnLookupRunnerDeps,
  options?: { batchSize?: number },
): Promise<void> {
  const job = await deps.loadJob(jobId);
  if (!job || !['pending', 'running'].includes(job.status)) return;

  const batchSize = Math.max(1, Math.min(50, options?.batchSize ?? DEFAULT_BATCH_SIZE));
  let progress: WebsiteInnLookupProgress = {
    processed: Math.max(0, job.processed),
    found: Math.max(0, job.found),
  };
  let lastAppliedProcessed = progress.processed;

  try {
    while (true) {
      if (await deps.isCancellationRequested(job.id)) {
        await deps.cancelJob(job, progress);
        return;
      }

      const pending = await deps.listPendingItems(job.id, batchSize);
      if (pending.length === 0) {
        await deps.completeJob(job, progress);
        return;
      }

      const outcomes = await deps.lookupItems(pending);
      if (outcomes.length !== pending.length) {
        throw new Error(`INN lookup returned ${outcomes.length}/${pending.length} outcomes`);
      }
      progress = await deps.persistOutcomes(job, outcomes, progress);

      // Построчные checkpoints сохраняются после каждого небольшого batch, но
      // compressed spreadsheet state большой. Переписывать его каждые 5 строк
      // для базы на несколько тысяч сайтов слишком дорого, поэтому применяем
      // промежуточные результаты раз в 100 строк. Финальный apply в любом
      // случае повторяется внутри complete/cancel/fail.
      if (
        progress.processed >= job.total
        || progress.processed - lastAppliedProcessed >= APPLY_RESULTS_INTERVAL
      ) {
        await deps.applyResults(job);
        lastAppliedProcessed = progress.processed;
      }
    }
  } catch (error) {
    await deps.failJob(job, error instanceof Error ? error.message : String(error), progress);
  }
}

async function lookupOne(item: WebsiteInnLookupPendingItem): Promise<WebsiteInnLookupResult> {
  try {
    const inn = await fetchInnFromWebsite(item.url, { timeout: SITE_TIMEOUT_MS });
    let companyName: string | null = null;
    let dadataError: string | null = null;
    if (inn && hasDadataKey()) {
      try {
        const suggestion = await findByInn(inn);
        companyName = suggestion?.data.name?.short_with_opf ?? suggestion?.value ?? null;
      } catch (error) {
        dadataError = `DaData: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      id: item.id,
      row_index: item.row_index,
      url: item.url,
      status: 'completed',
      inn,
      company_name: companyName,
      error_message: dadataError ?? (inn ? null : 'ИНН на сайте не найден'),
    };
  } catch (error) {
    return {
      id: item.id,
      row_index: item.row_index,
      url: item.url,
      status: 'failed',
      inn: null,
      company_name: null,
      error_message: error instanceof Error ? error.message : String(error),
    };
  }
}

function requireDb() {
  if (!supabaseAdmin) throw new Error('supabaseAdmin is not configured');
  return supabaseAdmin;
}

function createProductionDeps(): WebsiteInnLookupRunnerDeps {
  const db = requireDb();

  const apply = (job: WebsiteInnLookupJob) =>
    applyWebsiteInnLookupResults(
      job.user_id,
      job.id,
      job.tab_id,
      job.url_column,
      job.inn_column,
      job.company_column,
    );

  const finish = async (
    job: WebsiteInnLookupJob,
    status: 'completed' | 'cancelled' | 'failed',
    progress: WebsiteInnLookupProgress,
    errorMessage: string | null,
  ) => {
    const applied = await apply(job);
    const now = new Date().toISOString();
    await db
      .from('website_inn_lookup_jobs')
      .update({
        status,
        processed: progress.processed,
        found: progress.found,
        error_message: errorMessage,
        completed_at: now,
        updated_at: now,
        results_applied_at: applied ? now : null,
      })
      .eq('id', job.id)
      .in('status', ['pending', 'running']);
  };

  return {
    async loadJob(jobId) {
      const { data, error } = await db
        .from('website_inn_lookup_jobs')
        .select(
          'id, user_id, status, tab_id, url_column, inn_column, company_column, total, processed, found',
        )
        .eq('id', jobId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as WebsiteInnLookupJob | null) ?? null;
    },

    async isCancellationRequested(jobId) {
      const { data, error } = await db
        .from('website_inn_lookup_jobs')
        .select('cancel_requested, status')
        .eq('id', jobId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return !data || data.cancel_requested === true || data.status === 'cancelled';
    },

    async listPendingItems(jobId, limit) {
      const { data: selected, error: selectError } = await db
        .from('website_inn_lookup_items')
        .select('id, row_index, url')
        .eq('job_id', jobId)
        .eq('status', 'pending')
        .order('row_index', { ascending: true })
        .limit(limit);
      if (selectError) throw new Error(selectError.message);
      if (!selected?.length) return [];

      const ids = selected.map((item) => item.id);
      const now = new Date().toISOString();
      const { data: claimed, error: claimError } = await db
        .from('website_inn_lookup_items')
        .update({ status: 'running', started_at: now, updated_at: now })
        .in('id', ids)
        .eq('job_id', jobId)
        .eq('status', 'pending')
        .select('id, row_index, url');
      if (claimError) throw new Error(claimError.message);
      return (claimed ?? []) as WebsiteInnLookupPendingItem[];
    },

    async lookupItems(items) {
      return Promise.all(items.map(lookupOne));
    },

    async persistOutcomes(job, outcomes, current) {
      const now = new Date().toISOString();
      const rows = outcomes.map((outcome) => ({
        id: outcome.id,
        job_id: job.id,
        row_index: outcome.row_index,
        url: outcome.url,
        status: outcome.status,
        inn: outcome.inn,
        company_name: outcome.company_name,
        error_message: outcome.error_message,
        completed_at: now,
        updated_at: now,
      }));
      const { error: itemError } = await db
        .from('website_inn_lookup_items')
        .upsert(rows, { onConflict: 'id' });
      if (itemError) throw new Error(itemError.message);

      const next = {
        processed: current.processed + outcomes.length,
        found: current.found + outcomes.filter((outcome) => Boolean(outcome.inn)).length,
      };
      const { error: jobError } = await db
        .from('website_inn_lookup_jobs')
        .update({ ...next, updated_at: now })
        .eq('id', job.id)
        .eq('status', 'running');
      if (jobError) throw new Error(jobError.message);
      return next;
    },

    applyResults: apply,

    async completeJob(job, progress) {
      await finish(job, 'completed', progress, null);
    },

    async cancelJob(job, progress) {
      await finish(job, 'cancelled', progress, null);
    },

    async failJob(job, message, progress) {
      await finish(job, 'failed', progress, message.slice(0, 1000));
    },
  };
}

export async function runWebsiteInnLookupJob(jobId: string): Promise<void> {
  await executeWebsiteInnLookupJob(jobId, createProductionDeps(), {
    batchSize: Number(process.env.WEBSITE_INN_LOOKUP_CONCURRENCY ?? DEFAULT_BATCH_SIZE),
  });
}
