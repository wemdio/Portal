import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { loadClientHeProject } from '@/lib/hypothesisEngine/apiGuards';

export const dynamic = 'force-dynamic';

/**
 * POST — отменить все активные задачи СВОЕГО проекта (research, цепочки,
 * сборка/анализ баз, шаблоны). Зеркалит staff-роут: pending/running джобы →
 * 'cancelled', базы 'collecting'/'analyzing' → 'failed' («Cancelled by user»),
 * проект 'researching' → 'draft' (исследование можно запустить заново).
 * Уже завершённые джобы и готовые артефакты не трогаем.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const now = new Date().toISOString();
  const { data: cancelledJobs, error: jobsErr } = await supabaseAdmin
    .from('he_jobs')
    .update({ status: 'cancelled', finished_at: now, updated_at: now })
    .eq('project_id', id)
    .in('status', ['pending', 'running'])
    .select('id');
  if (jobsErr) {
    await logError('client.eng.cancel.jobs_failed', jobsErr, { userId: result.auth.userId, projectId: id });
    return jsonError(jobsErr.message, 500);
  }
  const cancelled = (cancelledJobs ?? []).length;
  if (cancelled === 0) {
    return jsonError('No active jobs — nothing to cancel', 409);
  }

  // Базы, которые ждали отменённые джобы, — в failed, чтобы не висели «в
  // работе» вечно и не держали слот автосборки вертикали.
  const { error: basesErr } = await supabaseAdmin
    .from('he_bases')
    .update({ status: 'failed', error: 'Cancelled by user', updated_at: now })
    .eq('project_id', id)
    .in('status', ['collecting', 'analyzing']);
  if (basesErr) {
    await logError('client.eng.cancel.bases_failed', basesErr, { userId: result.auth.userId, projectId: id });
  }

  // Research-пайплайн отменён — проект можно запустить заново с шага Brief.
  if ((owned.project as { status?: string }).status === 'researching') {
    const { error: updErr } = await supabaseAdmin
      .from('he_projects')
      .update({ status: 'draft', error: null, updated_at: now })
      .eq('id', id);
    if (updErr) {
      await logError('client.eng.cancel.project_failed', updErr, { userId: result.auth.userId, projectId: id });
    }
  }

  void logAudit('client.eng.cancelled', 'ENG cabinet project jobs cancelled', {
    userId: result.auth.userId,
    projectId: id,
    cancelled,
  });

  return NextResponse.json({ ok: true, cancelled });
}
