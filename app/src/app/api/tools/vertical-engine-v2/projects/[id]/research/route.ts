import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { enqueueVeResearchJob } from '@/lib/verticalEngineV2/researchJob';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// POST — запустить research-пайплайн по проекту. Одновременно может идти
// только один research-прогон: при активной research-стадии → 409.
// Дедуп + постановка первой стадии (site_profile) — в
// lib/verticalEngineV2/researchJob.ts (ею же пользуется клиентский ENG-контур).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.research.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { error: projErr } = await supabaseAdmin
        .from('ve_projects')
        .select('id')
        .eq('id', id)
        .single();
      if (projErr) {
        return jsonError(
          projErr.code === 'PGRST116' ? 'Проект не найден' : projErr.message,
          projErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const result = await enqueueVeResearchJob(supabaseAdmin, id);
      if (!result.ok) {
        if (result.reason === 'conflict') {
          return jsonError('Research уже выполняется для этого проекта', 409);
        }
        await logError('tools.vertical-engine-v2.research.enqueue_failed', new Error(result.message), {
          userId,
          projectId: id,
        });
        return jsonError(result.message ?? 'Не удалось поставить задачу', 500);
      }

      void logAudit('tools.vertical-engine-v2.research.started', 'Hypothesis engine research started', {
        userId,
        projectId: id,
        jobId: result.job.id,
      });

      return NextResponse.json({ ok: true, job: result.job });
    },
  );
}
