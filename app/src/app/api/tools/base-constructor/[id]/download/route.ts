import { NextRequest, NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { rowsToCsvChunks } from '@/lib/tools/rowsToCsv';
import { EXPORT_BUCKET, uploadExportArtifact } from '@/lib/tools/csvExportArtifact';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

function csvFilename(): string {
  return `constructor_${new Date().toISOString().slice(0, 10)}.csv`;
}

const CSV_HEADERS = {
  'content-type': 'text/csv; charset=utf-8',
  'cache-control': 'no-store',
} as const;

/**
 * CSV export of a base-constructor job.
 *
 * Artifact-first (Fix B, 2026-07-17): the worker stores a precomputed .csv.gz
 * in the base-constructor-exports bucket at job completion, so this route
 * streams ~3MB with sub-second TTFB. Before that, every download pulled the
 * whole `data` jsonb (up to ~50MB) out of PostgREST and built the CSV per
 * request — 13-15s before the first byte (the "не качается" incident).
 *
 * Legacy fallback (jobs completed before the artifact existed, or whose upload
 * failed): pull `data` and stream the CSV exactly as before (byte-identical,
 * rowsToCsvChunks), then lazily backfill the artifact fire-and-forget — but
 * ONLY for status='completed' jobs: an in-flight job's `data` is partial, and
 * caching it as the artifact would serve a stale partial export forever.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.download.get' },
    async () => {
      const user = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { id } = await params;
      // Meta only — deliberately NOT selecting `data` (up to ~50MB) here.
      const { data: job, error } = await admin
        .from('base_constructor_jobs')
        .select('user_id, status, export_path')
        .eq('id', id)
        .single();

      if (error || !job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (job.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      // ── Fast path: stored artifact ─────────────────────────────────────
      // The artifact path is DERIVED from the authenticated, ownership-checked
      // job id — NEVER from the client-writable export_path column. RLS lets a
      // user UPDATE their own row (base_constructor_jobs_update USING auth.uid()
      // = user_id, no column restriction), so a stored path string could be
      // pointed at another tenant's object; deriving it makes that impossible.
      // export_path is used ONLY as a "an artifact was built" flag.
      const artifactPath = `${id}.csv.gz`;
      if (job.export_path) {
        const { data: blob, error: dlErr } = await admin.storage
          .from(EXPORT_BUCKET)
          .download(artifactPath);
        if (!dlErr && blob) {
          const acceptsGzip = (req.headers.get('accept-encoding') ?? '').includes('gzip');
          if (acceptsGzip) {
            // Browser decompresses transparently; res.blob() sees plain CSV.
            return new NextResponse(blob.stream(), {
              status: 200,
              headers: {
                ...CSV_HEADERS,
                'content-encoding': 'gzip',
                vary: 'Accept-Encoding',
                'content-disposition': `attachment; filename="${csvFilename()}"`,
              },
            });
          }
          // Rare non-gzip client: decompress server-side. A corrupt artifact
          // must fall through to the legacy build, not 500 the download.
          try {
            const csv = gunzipSync(Buffer.from(await blob.arrayBuffer()));
            return new NextResponse(csv, {
              status: 200,
              headers: {
                ...CSV_HEADERS,
                'content-disposition': `attachment; filename="${csvFilename()}"`,
              },
            });
          } catch (e) {
            console.warn(
              `[base-constructor][${id}] artifact gunzip failed (${e instanceof Error ? e.message : String(e)}) — falling back to legacy CSV build`,
            );
          }
        } else {
          console.warn(
            `[base-constructor][${id}] artifact download failed (${dlErr?.message ?? 'no blob'}) — falling back to legacy CSV build`,
          );
        }
      }

      // ── Legacy path: build CSV from the data blob (streamed) ───────────
      const { data: full, error: fullErr } = await admin
        .from('base_constructor_jobs')
        .select('data')
        .eq('id', id)
        .single();
      if (fullErr || !full) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const rows = Array.isArray(full.data) ? (full.data as unknown[][]) : [];

      // Lazy backfill so the NEXT download hits the fast path. Completed only
      // (an in-flight job's `data` is partial — caching it would serve a stale
      // export forever). Fire-and-forget — never delays this response. Runs even
      // when export_path is set but the object was lost (upsert self-heals).
      if (job.status === 'completed' && rows.length > 0) {
        void (async () => {
          const artifact = await uploadExportArtifact(admin, id, rows);
          if (!artifact) return;
          await admin
            .from('base_constructor_jobs')
            .update({ export_path: artifact.path, export_bytes: artifact.bytes })
            .eq('id', id)
            .eq('status', 'completed');
          console.log(`[base-constructor][${id}] export artifact backfilled (${artifact.bytes}B)`);
        })().catch((err) =>
          console.warn(`[base-constructor][${id}] artifact backfill failed`, err),
        );
      }

      const encoder = new TextEncoder();
      const chunks = rowsToCsvChunks(rows);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const { value, done } = chunks.next();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(value));
        },
      });

      return new NextResponse(stream, {
        status: 200,
        headers: {
          ...CSV_HEADERS,
          'content-disposition': `attachment; filename="${csvFilename()}"`,
        },
      });
    },
  );
}
