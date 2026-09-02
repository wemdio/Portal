import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { stripBaseConstructorCheckpointMetadata } from '@/lib/tools/baseConstructorCheckpoint';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.data.get' },
    async () => {
      const user = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { id } = await params;

      // ?preview=N → return only the first N rows. The result `data` JSONB can be
      // tens of MB; shipping the whole blob just to render a 20-row preview froze
      // the client. The slice is done in Postgres so only ~N rows leave the DB.
      const previewRaw = req.nextUrl.searchParams.get('preview');
      const previewLimit = previewRaw ? Math.min(Math.max(parseInt(previewRaw, 10) || 0, 1), 200) : 0;

      if (previewLimit > 0) {
        // Cheap ownership check first (no data column → no de-TOAST / transfer).
        const { data: meta, error: metaErr } = await admin
          .from('base_constructor_jobs')
          .select('user_id')
          .eq('id', id)
          .single();
        if (metaErr || !meta) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        if (meta.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        const { data: slice, error: rpcErr } = await admin.rpc('base_constructor_job_data_slice', {
          p_id: id,
          p_limit: previewLimit,
        });
        if (!rpcErr) {
          const rows = Array.isArray(slice) ? (slice as string[][]) : [];
          return NextResponse.json({ data: stripBaseConstructorCheckpointMetadata(rows) });
        }

        // Fallback (e.g. RPC not yet deployed): fetch full data and slice in Node.
        // Still cheaper for the browser — it only ever receives the first N rows.
        const { data: full } = await admin
          .from('base_constructor_jobs')
          .select('data')
          .eq('id', id)
          .single();
        const rows = Array.isArray(full?.data) ? (full!.data as string[][]) : [];
        return NextResponse.json({
          data: stripBaseConstructorCheckpointMetadata(rows).slice(0, previewLimit),
        });
      }

      // Full data (used by the admin "Открыть в базах" flow).
      const { data: job, error } = await admin
        .from('base_constructor_jobs')
        .select('user_id, data')
        .eq('id', id)
        .single();

      if (error || !job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (job.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      const rows = Array.isArray(job.data) ? (job.data as string[][]) : [];
      return NextResponse.json({ data: stripBaseConstructorCheckpointMetadata(rows) });
    },
  );
}
