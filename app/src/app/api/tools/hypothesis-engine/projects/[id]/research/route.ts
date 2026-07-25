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

// Research-пайплайн целиком: воркер сам выстраивает цепочку стадий,
// роут ставит только первую (site_profile).
const RESEARCH_STAGES = [
  'site_profile',
  'competitors',
  'brand_cloud',
  'hypotheses',
  'evidence',
  'clustering',
];

// POST — запустить research-пайплайн по проекту. Одновременно может идти
// только один research-прогон: при активной research-стадии → 409.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.research.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { error: projErr } = await supabaseAdmin
        .from('he_projects')
        .select('id')
        .eq('id', id)
        .single();
      if (projErr) {
        return jsonError(
          projErr.code === 'PGRST116' ? 'Проект не найден' : projErr.message,
          projErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const { data: active, error: activeErr } = await supabaseAdmin
        .from('he_jobs')
        .select('id')
        .eq('project_id', id)
        .in('stage', RESEARCH_STAGES)
        .in('status', ['pending', 'running'])
        .limit(1);
      if (activeErr) return jsonError(activeErr.message, 500);
      if ((active ?? []).length > 0) {
        return jsonError('Research уже выполняется для этого проекта', 409);
      }

      const { data: job, error: jobErr } = await supabaseAdmin
        .from('he_jobs')
        .insert({ project_id: id, stage: 'site_profile', status: 'pending', payload: {} })
        .select()
        .single();
      if (jobErr || !job) {
        await logError('tools.hypothesis-engine.research.enqueue_failed', jobErr, { userId, projectId: id });
        return jsonError(jobErr?.message ?? 'Не удалось поставить задачу', 500);
      }

      const { error: updErr } = await supabaseAdmin
        .from('he_projects')
        .update({ status: 'researching', error: null })
        .eq('id', id);
      if (updErr) {
        await logError('tools.hypothesis-engine.research.status_failed', updErr, { userId, projectId: id });
        return jsonError(updErr.message, 500);
      }

      void logAudit('tools.hypothesis-engine.research.started', 'Hypothesis engine research started', {
        userId,
        projectId: id,
        jobId: job.id,
      });

      return NextResponse.json({ ok: true, job });
    },
  );
}
