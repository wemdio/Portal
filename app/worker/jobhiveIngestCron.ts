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
 *   4. DRY-RUN rehearsal before the first prod run (full DuckDB scan + row mapping,
 *      but NO DB connection and NO writes; prints the funnel counts + 5 sample rows).
 *      Use JOBHIVE_LIMIT to cap the export while rehearsing:
 *        cd /path/to/portal/app && JOBHIVE_LIMIT=2000 node --env-file=../.env dist/workers/jobhiveIngestCron.js --dry-run
 *   5. Manual first real run (measure yield before scheduling):
 *        cd /path/to/portal/app && node --env-file=../.env dist/workers/jobhiveIngestCron.js
 *   6. Then schedule via host crontab (survives redeploys), nightly AFTER the feed
 *      regenerates (~14:30 UTC), e.g.:
 *        30 16 * * * cd /path/to/portal/app && /usr/bin/node --env-file=../.env dist/workers/jobhiveIngestCron.js >> /var/log/portal/jobhive-ingest.log 2>&1
 *
 * Env knobs: JOBHIVE_FEED_URL, JOBHIVE_RECENCY_DAYS (default 90 — covers the 7/30/90
 * query options), JOBHIVE_INGEST_CHUNK (default 300), JOBHIVE_DRY_RUN=1 (same as the
 * --dry-run flag), JOBHIVE_LIMIT (positive int; caps scanned rows, for rehearsals),
 * DUCKDB_BIN.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Papa from 'papaparse';
import { createWorkerLogger, requireSupabaseAdmin } from './_shared';
import type { WorkerLogger } from './_shared';
import { upsertInChunksWithRetry } from '@/lib/parsers/engHiringRunner';
import {
  JOBHIVE_FEED_URL,
  buildJobhiveDuckdbSql,
  buildJobhiveDryRunReport,
  parseJobhiveLimit,
  processJobhiveRows,
  type JobhiveRow,
} from '@/lib/parsers/jobhiveIngest';

const WORKER_ID = 'jobhive-ingest-cron';
const RECENCY_DAYS = Math.max(1, Number(process.env.JOBHIVE_RECENCY_DAYS ?? '90'));
const DUCKDB_BIN = process.env.DUCKDB_BIN || 'duckdb';
const UPSERT_CHUNK = Math.max(1, Number(process.env.JOBHIVE_INGEST_CHUNK ?? '300'));
// Rehearsal mode: full scan + mapping, but no DB connection and no writes.
const DRY_RUN = process.argv.includes('--dry-run')
  || ['1', 'true', 'yes'].includes((process.env.JOBHIVE_DRY_RUN ?? '').trim().toLowerCase());

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

  // A typo'd limit must fail fast — silently ignoring it would mean an unbounded scan.
  let limit: number | null;
  try {
    limit = parseJobhiveLimit(process.env.JOBHIVE_LIMIT);
  } catch (err) {
    log('error', (err as Error).message);
    return 1;
  }

  const startedAt = Date.now();
  const cutoffIso = new Date(startedAt - RECENCY_DAYS * 86_400_000).toISOString();
  const sql = buildJobhiveDuckdbSql({ parquetUrl: JOBHIVE_FEED_URL, cutoffIso, limit });

  log('info', `${DRY_RUN ? '[DRY-RUN] ' : ''}Streaming jobhive feed (cutoff ${cutoffIso}, ${RECENCY_DAYS}d${limit != null ? `, limit ${limit}` : ''}) via DuckDB…`);
  let rawRows: JobhiveRow[];
  try {
    rawRows = scanFeed(sql, log);
  } catch (err) {
    log('error', 'DuckDB scan failed — is the duckdb binary installed and on PATH (or DUCKDB_BIN set)?', err);
    return 1;
  }
  log('info', `Coarse sales rows from feed: ${rawRows.length}`);

  // The SQL prefilter is deliberately broad; the shared pure pipeline applies the EXACT
  // title filter, folds legal-suffix name variants, recovers blank countries into one
  // row per company, and maps to eng_hiring_cache rows.
  const stats = processJobhiveRows(rawRows);
  log('info', `After exact title filter + company/country dedup: ${stats.mapped} companies`);

  if (DRY_RUN) {
    log('info', `\n${buildJobhiveDryRunReport(stats)}`);
    return 0;
  }

  const cacheRows = stats.cacheRows;
  if (cacheRows.length === 0) {
    log('info', 'Nothing to upsert');
    return 0;
  }

  // Real ingest only from here on — dry-run returns above without ever touching the DB.
  const supabase = requireSupabaseAdmin(log);

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
