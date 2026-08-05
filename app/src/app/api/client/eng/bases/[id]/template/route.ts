import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { loadClientHeBase } from '@/lib/hypothesisEngine/apiGuards';

export const dynamic = 'force-dynamic';

// POST — поставить генерацию шаблона 85/15 по СВОЕЙ проанализированной базе.
// База должна пройти анализ (status='analyzed'), иначе 409. Дедуп как у
// staff: активная template-задача на эту базу уже есть → 200 с ней же.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const owned = await loadClientHeBase(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  if ((owned.base as { status?: string }).status !== 'analyzed') {
    return jsonError('The base is not analyzed yet — wait for the analysis to finish', 409);
  }

  const { data: active, error: activeErr } = await supabaseAdmin
    .from('he_jobs')
    .select('*')
    .eq('project_id', owned.base.project_id as string)
    .eq('stage', 'template')
    .in('status', ['pending', 'running']);
  if (activeErr) return jsonError(activeErr.message, 500);
  const existing = (active ?? []).find(
    (j) => (j.payload as { base_id?: string } | null)?.base_id === id,
  );
  if (existing) return NextResponse.json({ ok: true, job: existing });

  const { data: job, error: jobErr } = await supabaseAdmin
    .from('he_jobs')
    .insert({
      project_id: owned.base.project_id as string,
      stage: 'template',
      status: 'pending',
      payload: { base_id: id },
    })
    .select()
    .single();
  if (jobErr || !job) {
    await logError('client.eng.template.enqueue_failed', jobErr, { userId: result.auth.userId, baseId: id });
    return jsonError(jobErr?.message ?? 'Failed to enqueue the job', 500);
  }

  void logAudit('client.eng.template.enqueued', 'ENG cabinet template enqueued', {
    userId: result.auth.userId,
    baseId: id,
    jobId: job.id,
  });

  return NextResponse.json({ ok: true, job }, { status: 201 });
}
