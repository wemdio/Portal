import 'server-only';
import { Pool } from 'pg';

/** A narrowly scoped, opt-in dispatch request; this is NOT a general requeue API. */
export const RUN24_PRIORITY_TARGET = Object.freeze({
  id: '15bf0bce-a13c-4401-99e2-e2e4aabe2973',
  clientUserId: '0a6d90e1-91d0-404e-b508-6b031bda7cfd',
  sourceFilename: 'no-email-retry-216fbc888469-0024-20261010.txt',
  savedRowIds: Object.freeze([
    ...Array.from({ length: 86 }, (_, index) => 7990 + index), 8077, 8078,
  ]),
  savedResultMd5: '14d3f5aea6d2b17ea37b99064183bdae',
  savedRows: 88,
  remainingRows: 12,
  totalRows: 100,
});

export type ManualPendingRun = {
  id: string;
  client_user_id: string;
  source_filename: string | null;
  unique_count: number;
};

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number | null };
export type PriorityDbClient = {
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>;
  release: () => void;
};
export type PriorityDbPool = { connect: () => Promise<PriorityDbClient> };

export type Run24PriorityClaim =
  | { kind: 'claimed'; run: ManualPendingRun }
  | { kind: 'busy' }
  | { kind: 'already-handled'; status: string };

export function isRun24PriorityEnabled(value: string | undefined): boolean {
  const normalized = value?.trim() ?? '';
  if (normalized === '' || normalized === '0') return false;
  if (normalized === '1') return true;
  throw new Error('MANUAL_SCORING_RUN24_PRIORITY_ONCE must be unset, 0, or 1');
}

/** No connection/pool is created at all in the default worker path. */
export function createRun24PriorityPool(env: NodeJS.ProcessEnv): Pool {
  const connectionString = (env.DATABASE_URL || env.SUPABASE_DB_URL || env.POSTGRES_URL || '').trim();
  if (!connectionString) throw new Error('Run24 priority requires the main operational Postgres URL');
  let url: URL;
  try { url = new URL(connectionString); } catch {
    throw new Error('Run24 priority has an invalid Postgres URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname === '144.31.54.166') {
    throw new Error('Run24 priority requires a current operational Postgres endpoint');
  }
  // Respect the existing URL's TLS settings; never disable certificate verification here.
  return new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'portal-manual-run24-priority',
  });
}

function count(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Run24 preflight missing ${key}`);
  return number;
}

/**
 * Lock/check/claim ONLY the existing run24 and its own rows in one transaction.
 * The original checksum is calculated by Postgres with UTC, exactly like the
 * saved read-only verification SQL (not a lossy JS timestamp conversion).
 * Requires the existing single daemon: this is not a replacement for a global
 * claim protocol, nor permission to invoke a competing handler.
 */
export async function claimRun24Priority(pool: PriorityDbPool): Promise<Run24PriorityClaim> {
  const client = await pool.connect();
  const target = RUN24_PRIORITY_TARGET;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('portal-manual-run24-priority-v1')) AS acquired",
    );
    if (lock.rows[0]?.acquired !== true) {
      await client.query('ROLLBACK');
      return { kind: 'busy' };
    }
    const runResult = await client.query(`
      SELECT id, client_user_id, source_filename, unique_count, status,
             is_no_email_retry, route_to_instantly
      FROM public.client_manual_score_runs WHERE id = $1 FOR UPDATE NOWAIT`, [target.id]);
    const run = runResult.rows[0];
    if (runResult.rows.length !== 1 || !run
        || run.client_user_id !== target.clientUserId
        || run.source_filename !== target.sourceFilename
        || run.is_no_email_retry !== true || run.route_to_instantly !== true
        || run.unique_count !== target.totalRows) {
      throw new Error('Run24 preflight identity/mode mismatch or missing run');
    }
    if (run.status !== 'pending') {
      if (!['processing', 'completed', 'failed'].includes(String(run.status))) {
        throw new Error('Run24 preflight unexpected status');
      }
      await client.query('ROLLBACK');
      return { kind: 'already-handled', status: String(run.status) };
    }
    const active = await client.query(`
      SELECT id FROM public.client_manual_score_runs
      WHERE status = 'processing' AND id <> $1 LIMIT 1`, [target.id]);
    if (active.rows.length > 0) {
      await client.query('ROLLBACK');
      return { kind: 'busy' };
    }
    // No other run's row is locked or written. The child locks prevent a
    // concurrent scoring write from changing these results during preflight.
    await client.query(`
      SELECT id FROM public.client_manual_score_rows
      WHERE run_id = $1 ORDER BY id FOR UPDATE`, [target.id]);
    const results = await client.query(`
      SELECT count(*)::int AS total_rows,
        count(*) FILTER (WHERE bucket IS NULL)::int AS remaining_rows,
        count(*) FILTER (WHERE error_message IS NOT NULL)::int AS row_errors,
        count(*) FILTER (WHERE id = ANY($2::bigint[]))::int AS saved_rows,
        count(*) FILTER (WHERE id = ANY($2::bigint[]) AND bucket IS NOT NULL
                              AND processed_at IS NOT NULL)::int AS processed_saved_rows,
        md5(string_agg(json_build_array(id, domain, score, rating, spf, email,
          email_validation_status, email2, email2_validation_status, bucket,
          error_message, processed_at)::text, '|' ORDER BY id)
          FILTER (WHERE id = ANY($2::bigint[]))) AS saved_result_md5
      FROM public.client_manual_score_rows WHERE run_id = $1`, [target.id, [...target.savedRowIds]]);
    const saved = results.rows[0] ?? {};
    if (count(saved, 'total_rows') !== target.totalRows
        || count(saved, 'remaining_rows') !== target.remainingRows
        || count(saved, 'row_errors') !== 0
        || count(saved, 'saved_rows') !== target.savedRows
        || count(saved, 'processed_saved_rows') !== target.savedRows
        || saved.saved_result_md5 !== target.savedResultMd5) {
      throw new Error('Run24 preflight saved 88 results / remaining 12 mismatch');
    }
    const receiptsResult = await client.query(`
      SELECT
        (SELECT count(*)::int FROM public.client_pipeline_domain_snapshots
          WHERE client_user_id = $2 AND source_kind = 'manual_scoring'
            AND source_run_id = $1::text) AS snapshots,
        (SELECT count(*)::int FROM public.client_campaign_append_batches
          WHERE client_user_id = $2 AND source_run_id = $1::text) AS batches,
        (SELECT count(*)::int FROM public.client_campaign_contact_ledger
          WHERE client_user_id = $2 AND source_run_id = $1::text) AS ledger_events`,
    [target.id, target.clientUserId]);
    const receipts = receiptsResult.rows[0] ?? {};
    if (['snapshots', 'batches', 'ledger_events'].some((key) => count(receipts, key) !== 0)) {
      throw new Error('Run24 preflight has prior receipts; separate reconciliation review required');
    }
    const claimed = await client.query(`
      UPDATE public.client_manual_score_runs SET status = 'processing'
      WHERE id = $1 AND client_user_id = $2 AND source_filename = $3
        AND status = 'pending' AND is_no_email_retry = true AND route_to_instantly = true
      RETURNING id, client_user_id, source_filename, unique_count`,
    [target.id, target.clientUserId, target.sourceFilename]);
    if (claimed.rowCount !== 1 || claimed.rows.length !== 1) {
      throw new Error('Run24 priority claim did not return exactly one run');
    }
    await client.query('COMMIT');
    return { kind: 'claimed', run: claimed.rows[0] as ManualPendingRun };
  } catch (error) {
    // An uncertain COMMIT must never trigger a direct/repeated handler call.
    // A durable processing status suppresses the one-shot after restart.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Serial selector, consumed BEFORE the canonical runner is invoked. */
export class Run24PrioritySelector {
  private consumed = false;
  private selecting = false;

  constructor(private readonly enabled: boolean) {}

  async selectNext(
    ordinary: () => Promise<ManualPendingRun | null>,
    claim: () => Promise<Run24PriorityClaim>,
  ): Promise<ManualPendingRun | null> {
    if (this.selecting) throw new Error('Manual priority selection must be serial');
    this.selecting = true;
    try {
      if (this.enabled && !this.consumed) {
        const result = await claim(); // Exceptions fail closed, never fall through.
        if (result.kind === 'busy') return null;
        this.consumed = true;
        if (result.kind === 'claimed') return result.run;
        // Never reset processing/completed/failed back to pending.
      }
      return await ordinary();
    } finally {
      this.selecting = false;
    }
  }
}
