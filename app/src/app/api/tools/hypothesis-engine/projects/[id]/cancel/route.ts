import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST — отменить все активные задачи проекта (research-пайплайн, цепочки,
 * вокабуляр, анализ/автосборка баз, шаблоны). Сценарий: запустили по ошибке,
 * воркер жжёт LLM API.
 *
 * pending/running джобы → 'cancelled': pending воркер больше не клеймит,
 * running обрывается через AbortSignal в LLM-слое (наблюдатель в
 * worker/hypothesisEngine.ts). Побочные состояния тоже чистим:
 *   - проект 'researching' → 'draft' (исследование можно запустить заново);
 *   - базы 'collecting'/'analyzing' → 'failed' («Отменено пользователем»),
 *     иначе они навсегда зависают без своей джобы (и collecting держит
 *     unique-индекс he_bases_one_collecting_per_vertical).
 * Уже завершённые (done/failed) джобы и готовые артефакты не трогаем.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.cancel.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data: project, error: projErr } = await supabaseAdmin
        .from('he_projects')
        .select('id, status')
        .eq('id', id)
        .single();
      if (projErr || !project) {
        return jsonError(
          projErr?.code === 'PGRST116' ? 'Проект не найден' : (projErr?.message ?? 'Проект не найден'),
          projErr?.code === 'PGRST116' ? 404 : 500,
        );
      }

      const now = new Date().toISOString();
      const { data: cancelledJobs, error: jobsErr } = await supabaseAdmin
        .from('he_jobs')
        .update({ status: 'cancelled', finished_at: now, updated_at: now })
        .eq('project_id', id)
        .in('status', ['pending', 'running'])
        .select('id');
      if (jobsErr) {
        await logError('tools.hypothesis-engine.cancel.jobs_failed', jobsErr, { userId, projectId: id });
        return jsonError(jobsErr.message, 500);
      }
      const cancelled = (cancelledJobs ?? []).length;
      if (cancelled === 0) {
        return jsonError('Нет активных задач — отменять нечего', 409);
      }

      // Базы, которые ждали отменённые джобы (автосборка / анализ), — в failed,
      // чтобы не висели «в работе» вечно и не держали слот автосборки вертикали.
      const { error: basesErr } = await supabaseAdmin
        .from('he_bases')
        .update({ status: 'failed', error: 'Отменено пользователем', updated_at: now })
        .eq('project_id', id)
        .in('status', ['collecting', 'analyzing']);
      if (basesErr) {
        await logError('tools.hypothesis-engine.cancel.bases_failed', basesErr, { userId, projectId: id });
      }

      // Research-пайплайн отменён — проект можно запустить заново с шага 1.
      if ((project as { status: string }).status === 'researching') {
        const { error: updErr } = await supabaseAdmin
          .from('he_projects')
          .update({ status: 'draft', error: null, updated_at: now })
          .eq('id', id);
        if (updErr) {
          await logError('tools.hypothesis-engine.cancel.project_failed', updErr, { userId, projectId: id });
        }
      }

      void logAudit('tools.hypothesis-engine.cancelled', 'Hypothesis engine jobs cancelled', {
        userId,
        projectId: id,
        cancelled,
      });

      return NextResponse.json({ ok: true, cancelled });
    },
  );
}
