import 'server-only';

import { createHash } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { Pool, type PoolClient } from 'pg';
import { to as postgresCopyTo } from 'pg-copy-streams';

import {
  buildClientReportExportSelectSql,
  buildClientReportExportStorageKey,
  isClientReportExportAccessCurrent,
  parseClientReportExportJob,
  type ClientReportExportJob,
} from './exportSql';
import {
  deleteMainS3Object,
  uploadMainS3Stream,
  type MainS3PutResult,
} from '@/lib/mainS3Server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

const EXPORT_RETENTION_DAYS = 7;
const ERROR_MESSAGE_LIMIT = 500;
export const CLIENT_REPORT_EXPORT_STATEMENT_TIMEOUT_MS = 30 * 60_000;

export const CLIENT_REPORT_EXPORT_CLAIM_SQL = `
WITH next_job AS (
  SELECT id
  FROM public.client_report_export_jobs
  WHERE status = 'pending'
  ORDER BY created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE public.client_report_export_jobs AS job
SET status = 'running',
    started_at = now(),
    finished_at = NULL,
    error_message = NULL
FROM next_job
WHERE job.id = next_job.id
  AND job.status = 'pending'
RETURNING job.id, job.client_user_id, job.kind, job.filters, job.status`;

const CLAIM_EXPIRED_SQL = `
WITH expired AS (
  SELECT id, storage_key
  FROM public.client_report_export_jobs
  WHERE status IN ('completed', 'cancelled')
    AND expires_at IS NOT NULL
    AND expires_at <= now()
    AND storage_key IS NOT NULL
  ORDER BY expires_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 20
)
UPDATE public.client_report_export_jobs AS job
SET status = 'cancelled',
    error_message = 'expired'
FROM expired
WHERE job.id = expired.id
RETURNING expired.id, expired.storage_key`;

type UploadInput = {
  key: string;
  body: Readable;
  contentType?: string;
  cacheControl?: string;
};

export type CompletedExportValues = {
  rowCount: number;
  storageKey: string;
  checksumSha256: string;
  finishedAt: string;
  expiresAt: string;
};

export type FailedExportValues = {
  errorMessage: string;
  finishedAt: string;
};

export type ClientReportExportWorkerDependencies = {
  now: () => Date;
  loadCurrentCampaignIds: (clientUserId: string) => Promise<string[]>;
  createCsvStream: (selectSql: string) => Readable;
  upload: (input: UploadInput) => Promise<MainS3PutResult>;
  markCompleted: (jobId: string, values: CompletedExportValues) => Promise<void>;
  markFailed: (jobId: string, values: FailedExportValues) => Promise<void>;
  deleteObject: (storageKey: string) => Promise<void>;
};

class CsvDataRowCounter extends Transform {
  private lineBreaks = 0;
  private sawData = false;
  private lastByte = -1;

  override _transform(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length > 0) {
      this.sawData = true;
      this.lastByte = buffer[buffer.length - 1];
      for (const byte of buffer) if (byte === 0x0a) this.lineBreaks += 1;
    }
    callback(null, buffer);
  }

  dataRows(): number {
    if (!this.sawData) return 0;
    const physicalLines = this.lineBreaks + (this.lastByte === 0x0a ? 0 : 1);
    return Math.max(0, physicalLines - 1); // COPY CSV HEADER contributes one line.
  }
}

class Sha256Transform extends Transform {
  private readonly hash = createHash('sha256');
  private finishedDigest: string | null = null;

  override _transform(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.hash.update(buffer);
    callback(null, buffer);
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.finishedDigest = this.hash.digest('hex');
    callback();
  }

  digest(): string {
    if (!this.finishedDigest) throw new Error('Export checksum requested before stream completion');
    return this.finishedDigest;
  }
}

export async function streamClientReportCsvGzip(input: {
  csv: Readable;
  storageKey: string;
  upload: (input: UploadInput) => Promise<MainS3PutResult>;
}): Promise<{
  rowCount: number;
  checksumSha256: string;
  storage: MainS3PutResult;
}> {
  const rowCounter = new CsvDataRowCounter();
  const checksum = new Sha256Transform();
  const body = new PassThrough();
  const gzip = createGzip({ level: 6 });

  const streamPromise = pipeline(input.csv, rowCounter, gzip, checksum, body);
  const uploadPromise = input.upload({
    key: input.storageKey,
    body,
    contentType: 'application/gzip',
    cacheControl: 'private, no-store',
  });

  try {
    const [, storage] = await Promise.all([streamPromise, uploadPromise]);
    return {
      rowCount: rowCounter.dataRows(),
      checksumSha256: checksum.digest(),
      storage,
    };
  } catch (error) {
    const streamError = error instanceof Error ? error : new Error(String(error));
    input.csv.destroy(streamError);
    body.destroy(streamError);
    await Promise.allSettled([streamPromise, uploadPromise]);
    throw error;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown export error');
  return message.replace(/[\r\n]+/g, ' ').slice(0, ERROR_MESSAGE_LIMIT);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

export async function processClaimedClientReportExport(
  job: ClientReportExportJob,
  deps: ClientReportExportWorkerDependencies,
): Promise<void> {
  if (job.status !== 'running') throw new Error(`Export job ${job.id} is not running`);
  const storageKey = buildClientReportExportStorageKey(job);
  let uploadCompleted = false;

  try {
    const currentCampaignIds = await deps.loadCurrentCampaignIds(job.clientUserId);
    if (!isClientReportExportAccessCurrent(job.filters, currentCampaignIds)) {
      throw new Error('Campaign access changed after this export was queued');
    }
    const selectSql = buildClientReportExportSelectSql(job);
    const result = await streamClientReportCsvGzip({
      csv: deps.createCsvStream(selectSql),
      storageKey,
      upload: deps.upload,
    });
    uploadCompleted = true;
    const finishedAt = deps.now();
    await deps.markCompleted(job.id, {
      rowCount: result.rowCount,
      storageKey: result.storage.key,
      checksumSha256: result.checksumSha256,
      finishedAt: finishedAt.toISOString(),
      expiresAt: addDays(finishedAt, EXPORT_RETENTION_DAYS).toISOString(),
    });
  } catch (error) {
    // If the object exists but the terminal DB write failed, make the operation
    // fail closed instead of leaving an untracked private object behind.
    if (uploadCompleted) await deps.deleteObject(storageKey).catch(() => undefined);
    try {
      await deps.markFailed(job.id, {
        errorMessage: safeErrorMessage(error),
        finishedAt: deps.now().toISOString(),
      });
    } catch {
      // Preserve the original export failure; the worker log still surfaces it.
    }
    throw error;
  }
}

type QueryClient = Pick<PoolClient, 'query'>;

export type ClientReportExportQueueTickDependencies = {
  cleanupExpired: (client: QueryClient) => Promise<number>;
  claim: (client: QueryClient) => Promise<ClientReportExportJob | null>;
  process: (job: ClientReportExportJob) => Promise<void>;
};

export async function processClientReportExportQueueTick(
  client: QueryClient,
  deps: ClientReportExportQueueTickDependencies,
): Promise<boolean> {
  await deps.cleanupExpired(client);
  const job = await deps.claim(client);
  if (!job) return false;
  await deps.process(job);
  return true;
}

export async function claimClientReportExportJob(
  client: QueryClient,
): Promise<ClientReportExportJob | null> {
  const result = await client.query(CLIENT_REPORT_EXPORT_CLAIM_SQL);
  const row = result.rows[0];
  if (!row) return null;
  try {
    return parseClientReportExportJob(row);
  } catch (error) {
    await client.query(
      `UPDATE public.client_report_export_jobs
       SET status = 'failed', error_message = $2, finished_at = now()
       WHERE id = $1::uuid AND status = 'running'`,
      [row.id, safeErrorMessage(error)],
    );
    throw error;
  }
}

async function updateExactlyOne(
  client: QueryClient,
  sql: string,
  values: unknown[],
  action: string,
): Promise<void> {
  const result = await client.query(sql, values);
  if (result.rowCount !== 1) throw new Error(`Could not ${action}: export job is no longer running`);
}

function createRuntimeDependencies(client: PoolClient): ClientReportExportWorkerDependencies {
  return {
    now: () => new Date(),
    loadCurrentCampaignIds: async (clientUserId) => {
      if (!supabaseInstantly) throw new Error('Instantly access database is not configured');
      const { data, error } = await supabaseInstantly
        .from('client_instantly_access')
        .select('resource_id')
        .eq('client_user_id', clientUserId)
        .eq('resource_type', 'campaign');
      if (error) throw new Error(`Campaign access check failed: ${error.message}`);
      return (data ?? []).flatMap((row) => {
        const resourceId = String(row.resource_id ?? '').trim();
        return resourceId ? [resourceId] : [];
      });
    },
    createCsvStream: (selectSql) => (
      client as unknown as { query(query: unknown): unknown }
    ).query(
      postgresCopyTo(`COPY (${selectSql}) TO STDOUT WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`),
    ) as Readable,
    upload: uploadMainS3Stream,
    deleteObject: deleteMainS3Object,
    markCompleted: async (jobId, values) => updateExactlyOne(
      client,
      `UPDATE public.client_report_export_jobs
       SET status = 'completed', row_count = $2, storage_key = $3,
           checksum_sha256 = $4, finished_at = $5::timestamptz,
           expires_at = $6::timestamptz, error_message = NULL
       WHERE id = $1::uuid AND status = 'running'`,
      [jobId, values.rowCount, values.storageKey, values.checksumSha256, values.finishedAt, values.expiresAt],
      'complete',
    ),
    markFailed: async (jobId, values) => {
      await client.query(
        `UPDATE public.client_report_export_jobs
         SET status = 'failed', error_message = $2, finished_at = $3::timestamptz
         WHERE id = $1::uuid AND status = 'running'`,
        [jobId, values.errorMessage, values.finishedAt],
      );
    },
  };
}

let exportPool: Pool | null = null;

function resolveDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL
    || process.env.SUPABASE_DB_URL
    || process.env.POSTGRES_URL
    || ''
  ).trim();
}

function shouldUseSsl(connectionString: string): boolean {
  const explicit = (process.env.DB_SSL || process.env.PGSSLMODE || '').toLowerCase();
  if (['require', 'true', '1'].includes(explicit)) return true;
  try {
    const url = new URL(connectionString);
    return url.searchParams.get('sslmode') === 'require' || url.hostname.endsWith('supabase.co');
  } catch { return false; }
}

function getExportPool(): Pool {
  if (exportPool) return exportPool;
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) throw new Error('DATABASE_URL / SUPABASE_DB_URL is required for report exports');
  exportPool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: CLIENT_REPORT_EXPORT_STATEMENT_TIMEOUT_MS,
    application_name: 'portal-client-report-export',
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  exportPool.on('error', (error) => {
    console.error('[client-report-export] idle pool error:', error.message);
  });
  return exportPool;
}

export async function cleanupExpiredClientReportExports(
  client: QueryClient,
  deleteObject: (storageKey: string) => Promise<void> = deleteMainS3Object,
): Promise<number> {
  const result = await client.query(CLAIM_EXPIRED_SQL);
  for (const row of result.rows as Array<{ id?: unknown; storage_key?: unknown }>) {
    if (typeof row.id !== 'string' || typeof row.storage_key !== 'string') continue;
    try {
      await deleteObject(row.storage_key);
      await client.query(
        `UPDATE public.client_report_export_jobs
         SET storage_key = NULL
         WHERE id = $1::uuid AND status = 'cancelled' AND storage_key = $2`,
        [row.id, row.storage_key],
      );
    } catch {
      // Keep the key on the cancelled row so the next idle tick retries cleanup.
    }
  }
  return result.rowCount ?? 0;
}

export async function resetRunningClientReportExports(client: QueryClient): Promise<number> {
  const result = await client.query(
    `UPDATE public.client_report_export_jobs
     SET status = 'pending', started_at = NULL, finished_at = NULL,
         row_count = NULL, storage_key = NULL, checksum_sha256 = NULL,
         expires_at = NULL, error_message = NULL
     WHERE status = 'running'
     RETURNING id`,
  );
  return result.rowCount ?? 0;
}

/** Dedicated service has one fixed container name, so startup can safely resume interrupted COPY jobs. */
export async function recoverRunningClientReportExports(): Promise<number> {
  const client = await getExportPool().connect();
  try { return await resetRunningClientReportExports(client); }
  finally { client.release(); }
}

/** Process at most one export, keeping a single DB connection for COPY + status. */
export async function processNextClientReportExport(): Promise<boolean> {
  const client = await getExportPool().connect();
  try {
    return await processClientReportExportQueueTick(client, {
      cleanupExpired: (queueClient) => cleanupExpiredClientReportExports(queueClient),
      claim: claimClientReportExportJob,
      process: (job) => processClaimedClientReportExport(job, createRuntimeDependencies(client)),
    });
  } finally {
    client.release();
  }
}

export async function closeClientReportExportPool(): Promise<void> {
  const pool = exportPool;
  exportPool = null;
  if (pool) await pool.end();
}
