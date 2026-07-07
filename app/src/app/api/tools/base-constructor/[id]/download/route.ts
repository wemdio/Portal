import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { rowsToCsvChunks } from '@/lib/tools/rowsToCsv';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

/**
 * Server-side CSV export of a completed base-constructor job.
 *
 * Previously the browser fetched the whole `data` JSONB (up to ~46 MB), parsed
 * it, and rebuilt the CSV client-side — so the download button stayed disabled
 * until that finished. Here we build the CSV on the server (same exact format as
 * the old client path, see rowsToCsv) and stream it as a file attachment, so the
 * button can be enabled the moment the job is completed.
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
      const { data: job, error } = await admin
        .from('base_constructor_jobs')
        .select('user_id, data')
        .eq('id', id)
        .single();

      if (error || !job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (job.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      const rows = Array.isArray(job.data) ? (job.data as unknown[][]) : [];
      // Stream the CSV chunk-by-chunk instead of building the whole (tens-of-MB)
      // string and returning it in one shot. rowsToCsvChunks yields the SAME
      // bytes as rowsToCsvFile (UTF-8 BOM first, so Excel detects UTF-8) — the
      // output is byte-identical, locked by rowsToCsv.test.ts — but the
      // ReadableStream applies backpressure, so a 13k-row / 14MB export no longer
      // builds a giant string and blocks the shared portal event loop (which
      // stretched such exports to ~60s under load; small bases were unaffected).
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
      const filename = `constructor_${new Date().toISOString().slice(0, 10)}.csv`;

      return new NextResponse(stream, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
    },
  );
}
