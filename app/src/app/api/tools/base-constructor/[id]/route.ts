import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { blockDemo } from '@/lib/auth/blockDemo';
import { withToolTrace } from '@/lib/toolTrace';
import { extractEmail, findColumnIndex } from '@/lib/tools/dfybUtils';
import { stripBaseConstructorCheckpointMetadata } from '@/lib/tools/baseConstructorCheckpoint';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { user: null, token: null };
  const { data } = await admin.auth.getUser(token);
  return { user: data.user, token };
}

/**
 * Self-heal jobs stuck in processing.
 *
 * Единственный случай, который чинит HTTP-роут:
 *
 * **Зависло на последнем шаге, 100%** — финальный update со status=completed
 * не успел пройти, но `data` уже актуальная. Помечаем completed,
 * пересчитываем result_stats из data — пользователь получает экспорт.
 *
 * Порог FINAL_STUCK_AFTER_MS — окно, в которое реальная медленная работа
 * не должна попасть: после 100% на последнем шаге остаётся только запись
 * результата, две минуты на неё — с запасом.
 */
async function autoCompleteIfStuck(jobId: string): Promise<void> {
  const FINAL_STUCK_AFTER_MS = 2 * 60_000;
  const { data: row } = await admin
    .from('base_constructor_jobs')
    .select('id, status, current_step, current_step_key, total_steps, current_step_progress, started_at, run_token, data')
    .eq('id', jobId)
    .single();
  if (!row) return;
  if (row.status !== 'processing') return;
  if ((row.current_step_progress ?? 0) < 100) return;
  // Legacy validate workers could publish 100 before their filtered result was
  // durable. Never auto-complete that ambiguous checkpoint in the API; the
  // dedicated worker reclaims it and intentionally replays validate_emails.
  if (row.current_step_key === 'validate_emails') return;

  const startedAt = row.started_at ? new Date(row.started_at).getTime() : 0;
  if (!startedAt) return;
  const elapsedMs = Date.now() - startedAt;

  const isLastStep = row.current_step === row.total_steps;

  // Случай 1: финальный шаг, > 2 минут — пересчитываем stats и завершаем.
  if (isLastStep && elapsedMs >= FINAL_STUCK_AFTER_MS) {
    const data = stripBaseConstructorCheckpointMetadata((row.data as string[][] | null) ?? []);
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
    let completeQuery = admin
      .from('base_constructor_jobs')
      .update({
        data,
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
      .eq('status', 'processing')
      // A heartbeat/reclaim after our read means this snapshot is stale.
      .eq('started_at', row.started_at);
    if (row.run_token) completeQuery = completeQuery.eq('run_token', row.run_token);
    await completeQuery;
    return;
  }

  // Промежуточный шаг без живого исполнителя перехватывает сам воркер по
  // истёкшей аренде (lib/jobs/lifecycle.ts). HTTP-процесс задачи не запускает.
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.by-id.get' },
    async () => {
      const { user, token } = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      // This GET triggers autoCompleteIfStuck() which MUTATES the job row — a
      // hidden side effect, so it must be demo-gated like the mutating handlers.
      const supabase = createAuthedSupabaseClient(token!);
      const demo = await blockDemo(supabase, user.id);
      if (demo) return demo;

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
      const { user, token } = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const supabase = createAuthedSupabaseClient(token!);
      const demo = await blockDemo(supabase, user.id);
      if (demo) return demo;

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
