/**
 * Precomputed CSV-export artifact for base-constructor jobs.
 *
 * The worker calls uploadExportArtifact() once, at job completion, with the
 * final rows it already holds in memory: rows -> rowsToCsvChunks (the exact
 * same bytes the download route would stream) -> gzip -> private storage
 * bucket. The download route then serves the ~3MB .csv.gz with sub-second
 * TTFB instead of pulling the ~50MB `data` jsonb per request (13-15s TTFB,
 * the "не качается" incident of 2026-07).
 *
 * Contract: uploadExportArtifact NEVER throws and is bounded by a timeout —
 * a storage blip must not fail (or stall) an 8-hour job whose data is already
 * safely persisted in the jobs row. On any failure the job simply completes
 * without an artifact and the download route falls back to the legacy path.
 */

import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { rowsToCsvChunks } from './rowsToCsv';

export const EXPORT_BUCKET = 'base-constructor-exports';
const UPLOAD_TIMEOUT_MS = 30_000;

/** Minimal structural slice of the supabase client we need (test-friendly). */
export interface ExportStorageClient {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Buffer,
        opts: { contentType: string; upsert: boolean },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
}

/**
 * Gzip the CSV without ever materialising the full multi-MB CSV string:
 * rowsToCsvChunks yields ~1000-row string chunks straight into a gzip stream
 * with backpressure. Output decompresses to EXACTLY rowsToCsvFile(rows)
 * (BOM first) — locked by csvExportArtifact.test.ts.
 */
export async function buildCsvGzip(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): Promise<Buffer> {
  const out: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(chunk);
      cb();
    },
  });
  await pipeline(Readable.from(rowsToCsvChunks(rows)), createGzip({ level: 6 }), sink);
  return Buffer.concat(out);
}

/**
 * Build + upload the artifact for a job. Returns { path, bytes } on success,
 * null on ANY failure (logged) — callers treat null as "no artifact".
 */
export async function uploadExportArtifact(
  client: ExportStorageClient,
  jobId: string,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  timeoutMs: number = UPLOAD_TIMEOUT_MS,
): Promise<{ path: string; bytes: number } | null> {
  try {
    const gz = await buildCsvGzip(rows);
    const path = `${jobId}.csv.gz`;
    const timeout = new Promise<{ error: { message: string } }>((resolve) => {
      const t = setTimeout(
        () => resolve({ error: { message: `upload timeout after ${timeoutMs}ms` } }),
        timeoutMs,
      );
      // Не держим event-loop воркера живым из-за таймера.
      if (typeof t === 'object' && 'unref' in t) t.unref();
    });
    const { error } = await Promise.race([
      client.storage.from(EXPORT_BUCKET).upload(path, gz, {
        contentType: 'application/gzip',
        upsert: true,
      }),
      timeout,
    ]);
    if (error) {
      console.warn(`[csv-export-artifact][${jobId}] upload failed: ${error.message}`);
      return null;
    }
    return { path, bytes: gz.length };
  } catch (err) {
    console.warn(
      `[csv-export-artifact][${jobId}] build/upload threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
