import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { extractEmail, findColumnIndex } from '@/lib/tools/dfybUtils';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

/**
 * Self-heal jobs that are stuck at processing/100% with no recent worker
 * activity (e.g. server restarted between the per-step data save and the
 * final completion update). We compute result_stats from the saved data
 * and mark the job completed so the UI exposes export controls.
 */
async function autoCompleteIfStuck(jobId: string): Promise<void> {
  const STUCK_AFTER_MS = 2 * 60_000;
  const { data: row } = await admin
    .from('base_constructor_jobs')
    .select('id, status, current_step, total_steps, current_step_progress, started_at, data')
    .eq('id', jobId)
    .single();
  if (!row) return;
  if (row.status !== 'processing') return;
  if (row.current_step !== row.total_steps) return;
  if ((row.current_step_progress ?? 0) < 100) return;
  const startedAt = row.started_at ? new Date(row.started_at).getTime() : 0;
  if (!startedAt || Date.now() - startedAt < STUCK_AFTER_MS) return;
  const data = (row.data as string[][] | null) ?? [];
  if (data.length < 2) return;
  const header = data[0] ?? [];
  const body = data.slice(1);
  const emailIdx = findColumnIndex(header, 'email');
  const scoreIdx = findColumnIndex(header, 'ца балл', 'цабалл', 'ta score');
  const emailsFound =
    emailIdx >= 0 ? body.filter((r) => extractEmail(r[emailIdx] || '')).length : 0;
  const avgScore =
    scoreIdx >= 0
      ? body.reduce((s, r) => s + (parseInt(r[scoreIdx], 10) || 0), 0) / (body.length || 1)
      : 0;
  await admin
    .from('base_constructor_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      current_step_key: 'done',
      current_step_progress: 100,
      result_stats: {
        total_rows: body.length,
        emails_found: emailsFound,
        avg_ta_score: Math.round(avgScore * 10) / 10,
        columns: header.length,
      },
    })
    .eq('id', jobId)
    .eq('status', 'processing');
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.by-id.get' },
    async () => {
      const user = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { id } = await params;
      await autoCompleteIfStuck(id).catch((err) =>
        console.error('[base-constructor] autoCompleteIfStuck failed', err),
      );
      const { data: job, error } = await admin
        .from('base_constructor_jobs')
        .select('id, user_id, status, file_name, selected_steps, step_config, current_step, current_step_key, current_step_progress, total_steps, initial_row_count, result_stats, error_message, created_at, started_at, completed_at')
        .eq('id', id)
        .single();

      if (error || !job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (job.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      return NextResponse.json({ job });
    },
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.by-id.patch' },
    async () => {
      const user = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { id } = await params;
      const body = await req.json();

      if (body.action === 'cancel') {
        const { error } = await admin
          .from('base_constructor_jobs')
          .update({ status: 'cancelled', completed_at: new Date().toISOString() })
          .eq('id', id)
          .eq('user_id', user.id)
          .in('status', ['pending', 'processing']);

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    },
  );
}
