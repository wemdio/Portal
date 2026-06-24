/**
 * One-shot cron entry: ingest the jobhive bulk feed into eng_hiring_cache.
 *
 * jobhive (storage.stapply.ai/jobhive/v1, MIT) is a daily-regenerated catalog of
 * ~4.3M postings across 47 ATS platforms — including the enterprise ATS (iCIMS,
 * Oracle, Phenom, SuccessFactors…) whose closed APIs we cannot fetch ourselves. We
 * stream it with the DuckDB CLI (httpfs, column pruning, predicate + window dedup all
 * pushed to the scan), apply the EXACT sales-title filter + per-(company,country)
 * dedup in Node (reusing engHiring logic), and upsert as the cache-only source
 * 'jobhive'. The normal ENG run then queries+filters+dedups+enriches those rows like
 * any native source (domain recovered by the PDL resolver in the enrich pass).
 *
 * Prereqs / deploy:
 *   1. Once: worker/jobhiveIngestCron.ts is in the build:workers esbuild list ->
 *      dist/workers/jobhiveIngestCron.js.
 *   2. Apply migration 20260624_0002 (adds 'jobhive' to the source CHECK constraints).
 *   3. DuckDB single binary must be on PATH (or set DUCKDB_BIN). Same binary the pdl
 *      loader uses — see app/scripts/pdl/README.md.
 *   4. Manual first run (measure yield before scheduling):
 *        cd /path/to/portal/app && node --env-file=../.env dist/workers/jobhiveIngestCron.js
 *   5. Then schedule via host crontab (survives redeploys), nightly AFTER the feed
 *      regenerates (~14:30 UTC), e.g.:
 *        30 16 * * * cd /path/to/portal/app && /usr/bin/node --env-file=../.env dist/workers/jobhiveIngestCron.js >> /var/log/portal/jobhive-ingest.log 2>&1
 *
 * Env knobs: JOBHIVE_FEED_URL, JOBHIVE_RECENCY_DAYS (default 90 — covers the 7/30/90
 * query options), JOBHIVE_INGEST_CHUNK (default 300), DUCKDB_BIN.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Papa from 'papaparse';
import { createWorkerLogger, requireSupabaseAdmin } from './_shared';
import type { WorkerLogger } from './_shared';
import { upsertInChunksWithRetry } from '@/lib/parsers/engHiringRunner';
import { isHighIntentB2BSalesTitle } from '@/lib/parsers/engHiring';
import {
  JOBHIVE_FEED_URL,
  buildJobhiveDuckdbSql,
  dedupeJobhiveRowsByCompanyCountry,
  mapJobhiveRowToCacheRow,
  type JobhiveRow,
} from '@/lib/parsers/jobhiveIngest';

const WORKER_ID = 'jobhive-ingest-cron';
const RECENCY_DAYS = Math.max(1, Number(process.env.JOBHIVE_RECENCY_DAYS ?? '90'));
const DUCKDB_BIN = process.env.DUCKDB_BIN || 'duckdb';
const UPSERT_CHUNK = Math.max(1, Number(process.env.JOBHIVE_INGEST_CHUNK ?? '300'));

/** Run the DuckDB scan, writing the (already coarse-deduped) result to a temp CSV, and
 *  parse it back. COPY-to-file (not stdout) so a large result never overflows a pipe. */
function scanFeed(sql: string, log: WorkerLogger): JobhiveRow[] {
  const dir = mkdtempSync(join(tmpdir(), 'jobhive-'));
  const outPath = join(dir, 'jobhive.csv').replace(/\\/g, '/');
  const script = `INSTALL httpfs; LOAD httpfs;\nCOPY (\n${sql}\n) TO '${outPath}' (FORMAT CSV, HEADER);`;
  try {
    execFileSync(DUCKDB_BIN, ['-c', script], { stdio: ['ignore', 'inherit', 'inherit'] });
    const csv = readFileSync(outPath, 'utf8');
    const parsed = Papa.parse<JobhiveRow>(csv, { header: true, skipEmptyLines: true });
    if (parsed.errors.length) log('warn', `CSV parse reported ${parsed.errors.length} issue(s); first: ${parsed.errors[0]?.message}`);
    return parsed.data;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const supabase = requireSupabaseAdmin(log);

  const startedAt = Date.now();
  const cutoffIso = new Date(startedAt - RECENCY_DAYS * 86_400_000).toISOString();
  const sql = buildJobhiveDuckdbSql({ parquetUrl: JOBHIVE_FEED_URL, cutoffIso });

  log('info', `Streaming jobhive feed (cutoff ${cutoffIso}, ${RECENCY_DAYS}d) via DuckDB…`);
  let rawRows: JobhiveRow[];
  try {
    rawRows = scanFeed(sql, log);
  } catch (err) {
    log('error', 'DuckDB scan failed — is the duckdb binary installed and on PATH (or DUCKDB_BIN set)?', err);
    return 1;
  }
  log('info', `Coarse sales rows from feed: ${rawRows.length}`);

  // The SQL prefilter is deliberately broad; apply the EXACT title filter, then fold
  // legal-suffix name variants and recover blank countries into one row per company.
  const salesRows = rawRows.filter((row) => isHighIntentB2BSalesTitle(String(row.title ?? '')));
  const deduped = dedupeJobhiveRowsByCompanyCountry(salesRows);
  const cacheRows = deduped
    .map(mapJobhiveRowToCacheRow)
    .filter((row): row is NonNullable<typeof row> => row != null);
  log('info', `After exact title filter + company/country dedup: ${cacheRows.length} companies`);

  if (cacheRows.length === 0) {
    log('info', 'Nothing to upsert');
    return 0;
  }

  const nowIso = new Date().toISOString();
  const stamped = cacheRows.map((row) => ({ ...row, last_seen_at: nowIso, cache_fetched_at: nowIso, updated_at: nowIso }));

  try {
    await upsertInChunksWithRetry(
      (chunk) => supabase
        .from('eng_hiring_cache')
        .upsert(chunk as Record<string, unknown>[], { onConflict: 'source,source_job_id' }) as unknown as Promise<{ error: { message: string } | null }>,
      stamped,
      { chunkSize: UPSERT_CHUNK, retries: 4, delayMs: 500, label: 'jobhive cache upsert' },
    );
  } catch (err) {
    log('error', 'Upsert into eng_hiring_cache failed', err);
    return 1;
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  log('info', `Done: upserted ${stamped.length} jobhive companies in ${elapsedSec}s`);
  return 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[worker][jobhive-ingest-cron][FATAL]', err);
    process.exit(1);
  });
