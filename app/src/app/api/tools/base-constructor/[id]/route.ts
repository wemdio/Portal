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
 * Self-heal jobs stuck in processing.
 *
 * Архитектурный фон: base-constructor исторически живёт fire-and-forget
 * promise'ом в HTTP-процессе portal'a. При любом рестарте контейнера
 * (deploy/OOM/healthcheck) promise умирает посередине, и БД остаётся
 * с status='processing' без живой работы. Юзер видит «висит на N%»
 * сутками. Реальный фикс — переезд на отдельного worker'a, но пока
 * чиним симптомами.
 *
 * Две стратегии в зависимости от того, где умерло:
 *
 * 1. **Зависло на последнем шаге, 100%** — финальный update со status=completed
 *    не успел пройти, но `data` уже актуальная. Помечаем completed,
 *    пересчитываем result_stats из data — пользователь получает экспорт.
 *
 * 2. **Зависло на промежуточном шаге** (current_step < total_steps) — данные
 *    обработаны частично, дальнейшие шаги (ta_scoring, persona и т.д.)
 *    не выполнены. Помечать completed неправильно — это введёт юзера
 *    в заблуждение и испортит метрики. Помечаем failed с пояснением,
 *    чтобы UI разблокировался и юзер запустил заново. Случай Вероники:
 *    find_emails (3/4) 100%, clean_names (4/4) даже не запускался.
 *
 * Порог STUCK_AFTER_MS — окно, в которое реальная медленная работа
 * не должна попасть. find_emails на 1.5k строках занимает 10-20 минут;
 * 15 минут на промежуточном шаге — уже точно «зависло» (нет других
 * промежуточных шагов в пайплайне которые столько идут).
 */
async function autoCompleteIfStuck(jobId: string): Promise<void> {
  const FINAL_STUCK_AFTER_MS = 2 * 60_000;
  const INTERMEDIATE_STUCK_AFTER_MS = 15 * 60_000;
  const { data: row } = await admin
    .from('base_constructor_jobs')
    .select('id, status, current_step, total_steps, current_step_progress, started_at, data')
    .eq('id', jobId)
    .single();
  if (!row) return;
  if (row.status !== 'processing') return;
  if ((row.current_step_progress ?? 0) < 100) return;

  const startedAt = row.started_at ? new Date(row.started_at).getTime() : 0;
  if (!startedAt) return;
  const elapsedMs = Date.now() - startedAt;

  const isLastStep = row.current_step === row.total_steps;

  // Случай 1: финальный шаг, > 2 минут — пересчитываем stats и завершаем.
  if (isLastStep && elapsedMs >= FINAL_STUCK_AFTER_MS) {
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
    return;
  }

  // Случай 2: промежуточный шаг, > 15 минут — помечаем failed.
  if (!isLastStep && elapsedMs >= INTERMEDIATE_STUCK_AFTER_MS) {
    await admin
      .from('base_constructor_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message:
          `Задача зависла между шагами (${row.current_step}/${row.total_steps}, ` +
          `${Math.round(elapsedMs / 60_000)} мин без прогресса). ` +
          'Скорее всего был рестарт сервера. Запустите заново.',
      })
      .eq('id', jobId)
      .eq('status', 'processing');
    return;
  }
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
