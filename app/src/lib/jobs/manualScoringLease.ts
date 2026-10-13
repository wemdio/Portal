import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { manualDbRequest } from './manualScoringDbRequest';
import {
  isTransientManualDbError, manualRowPayloadMatches, processManualRun,
  type ManualProcessedRowPayload, type ProcessOptions, type ProcessResult,
} from './manualScoringRunner';

export interface ClaimedManualRun {
  id: string;
  client_user_id: string;
  source_filename: string | null;
  unique_count: number;
  worker_token: string;
  worker_lease_until: string;
  worker_phase: 'scoring' | 'routing';
}

interface RetryOptions { delayMs?: number; attempts?: number }
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function dbError(error: { message: string }): Error {
  return Object.assign(new Error(error.message), error);
}

async function retryDb<T>(work: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.min(5, opts.attempts ?? 3));
  for (let attempt = 1; ; attempt++) {
    try { return await work(); } catch (error) {
      if (attempt >= attempts || !isTransientManualDbError(error)) throw error;
      const delay = Math.max(0, opts.delayMs ?? 500) * 2 ** (attempt - 1);
      if (delay) await pause(delay);
    }
  }
}

/** Same token on every retry: an ambiguous claim must not claim a second run. */
export async function claimManualScoreRun(
  db: SupabaseClient, token = randomUUID(), retry: RetryOptions = {},
): Promise<ClaimedManualRun | null> {
  return retryDb(async () => {
    const { data, error } = await manualDbRequest(db.rpc('claim_manual_score_run', { p_token: token }));
    if (error) throw dbError(error);
    if (!data) return null;
    const claimed = data as ClaimedManualRun;
    if (claimed.worker_token !== token || !claimed.id || claimed.worker_phase !== 'scoring'
        || (data as Record<string, unknown>).status !== 'processing'
        || !Number.isFinite(Date.parse(claimed.worker_lease_until)) || Date.parse(claimed.worker_lease_until) <= Date.now()) {
      throw new Error('Invalid manual scoring claim receipt');
    }
    return claimed;
  }, retry);
}

/** One invocation owns a lease. No generic stale/failed-run UPDATE exists here. */
export class ManualScoringLease {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private failure: unknown;
  private until: number;
  private checkedAt = 0;
  private renewal: Promise<void> | undefined;

  constructor(
    private readonly db: SupabaseClient,
    readonly run: ClaimedManualRun,
    private readonly retry: RetryOptions = {},
  ) { this.until = Date.parse(run.worker_lease_until); }

  get unhealthy(): boolean { return this.failure !== undefined; }

  startHeartbeat(onError: (error: unknown) => void): void {
    this.timer = setInterval(() => {
      void this.renew().catch((error) => { this.failure = error; onError(error); });
    }, 30_000);
  }

  async stopHeartbeat(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.queue.catch(() => undefined);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next;
    return next;
  }

  private async action(action: string, patch: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let uncertain = false;
    const matchesPatch = (saved: Record<string, unknown>, expected: Record<string, unknown>) =>
      Object.entries(expected).every(([key, value]) => key === 'finished_at' && value != null
        ? Date.parse(String(saved[key])) === Date.parse(String(value)) : saved[key] === value);
    const validReceipt = (saved: Record<string, unknown>): boolean => {
      const status = action === 'release' ? 'pending' : patch.status ?? 'processing';
      if (saved.id !== this.run.id || saved.status !== status || !matchesPatch(saved, patch)) return false;
      if (status === 'pending' || status === 'completed' || status === 'failed') {
        return saved.worker_token === null && saved.worker_lease_until === null && saved.worker_phase === null;
      }
      return saved.worker_token === this.run.worker_token
        && saved.worker_phase === (action === 'routing' ? 'routing' : this.run.worker_phase)
        && Number.isFinite(Date.parse(String(saved.worker_lease_until)))
        && Date.parse(String(saved.worker_lease_until)) > Date.now();
    };
    return retryDb(async () => {
      try {
        const { data, error } = await manualDbRequest(this.db.rpc('manual_score_lease_action', {
          p_run_id: this.run.id, p_token: this.run.worker_token, p_action: action, p_patch: patch,
        }));
        if (error) throw dbError(error);
        if (!data || typeof data !== 'object' || !validReceipt(data as Record<string, unknown>)) {
          throw new Error('Invalid manual scoring lease receipt');
        }
        return data as Record<string, unknown>;
      } catch (error) {
        uncertain ||= isTransientManualDbError(error);
        // Terminal/release responses can be lost after COMMIT. Do not blindly
        // perform the next claim: prove exactly that transition first.
        if (uncertain && (action === 'release' || patch.status === 'completed' || patch.status === 'failed')) {
          const { data: saved, error: readError } = await manualDbRequest(this.db.from('client_manual_score_runs')
            .select('id, status, worker_token, worker_lease_until, worker_phase, finished_at, error_message, processed_count, bucket_storage_count, bucket_medium_count, bucket_high_count, bucket_top_count')
            .eq('id', this.run.id).maybeSingle());
          if (readError) throw dbError(readError);
          const actual = saved as Record<string, unknown> | null;
          if (actual && validReceipt(actual)) return actual;
        }
        throw error;
      }
    }, this.retry);
  }

  renew(): Promise<void> {
    if (this.renewal) return this.renewal;
    this.renewal = this.serialize(async () => {
      if (this.closed) return;
      if (this.failure) throw this.failure;
      const saved = await this.action('renew');
      this.until = Date.parse(String(saved.worker_lease_until));
      this.checkedAt = Date.now();
    }).finally(() => { this.renewal = undefined; });
    return this.renewal;
  }

  async assertOwnership(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('Manual scoring lease is closed');
    // The SQL row write is always fenced. This check also stops new provider
    // work well before expiry, even if the local heartbeat was delayed.
    if (Date.now() - this.checkedAt >= 5_000 || Date.now() + 30_000 >= this.until) await this.renew();
  }

  async beforeReconcile(): Promise<void> {
    await this.assertOwnership();
    await this.serialize(async () => {
      const saved = await this.action('routing');
      this.until = Date.parse(String(saved.worker_lease_until));
      this.run.worker_phase = 'routing';
    });
  }

  async persistRow(rowId: number, payload: ManualProcessedRowPayload): Promise<void> {
    const { data, error } = await manualDbRequest(this.db.rpc('save_manual_score_row', {
      p_run_id: this.run.id, p_token: this.run.worker_token, p_row_id: rowId, p_payload: payload,
    }));
    if (error) throw dbError(error);
    if (!data || (data as Record<string, unknown>).id !== rowId || (data as Record<string, unknown>).run_id !== this.run.id
        || !manualRowPayloadMatches(data as Record<string, unknown>, payload)) {
      throw new Error(`Manual score row ${rowId} has a different saved result`);
    }
  }

  async updateRunState(patch: Record<string, unknown>): Promise<void> {
    await this.serialize(async () => {
      const saved = await this.action('update', patch);
      if (saved.status === 'completed' || saved.status === 'failed') this.closed = true;
    });
  }

  /** Called only after ALL in-flight rows have settled, never during routing. */
  async release(): Promise<void> {
    await this.serialize(async () => {
      await this.action('release');
      this.closed = true;
    });
  }
}

/** Single claimed invocation; a nonzero/throw is required if release is unknown. */
export async function processClaimedManualRun(
  db: SupabaseClient, run: ClaimedManualRun,
  options: Pick<ProcessOptions, 'endpoint' | 'concurrency'> & {
    shouldStop: () => boolean;
    onLeaseError: (error: unknown) => void;
  },
): Promise<ProcessResult> {
  const lease = new ManualScoringLease(db, run);
  lease.startHeartbeat(options.onLeaseError);
  let result: ProcessResult;
  try {
    result = await processManualRun({
      runId: run.id, endpoint: options.endpoint, concurrency: options.concurrency,
      skipMarkProcessing: true,
      shouldStop: () => options.shouldStop() || lease.unhealthy,
      assertOwnership: () => lease.assertOwnership(),
      beforeReconcile: () => lease.beforeReconcile(),
      persistRow: (rowId, payload) => lease.persistRow(rowId, payload),
      updateRunState: (patch) => lease.updateRunState(patch),
      onProgress: (processed) => lease.updateRunState({ processed_count: processed }),
    });
  } finally { await lease.stopHeartbeat(); }
  if (result.status === 'paused') {
    await lease.release();
    if (!options.shouldStop()) throw new Error(`Run ${run.id} stopped after a lease/ownership failure`);
  }
  return result;
}
