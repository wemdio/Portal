import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { enqueueHeResearchJob } from '@/lib/hypothesisEngine/researchJob';
import { toClientEngJobRow } from '@/lib/hypothesisEngine/clientEngProjection';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

// POST — перезапустить research-пайплайн СВОЕГО проекта (кнопка «Re-run
// research» шага Brief). Дедуп тот же, что у staff: активная research-стадия → 409.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.research.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const enqueue = await enqueueHeResearchJob(supabaseAdmin, id);
    if (!enqueue.ok) {
      if (enqueue.reason === 'conflict') {
        return jsonError('Research is already running for this project', 409);
      }
      return engServerError(
        'client.eng.research.enqueue_failed',
        new Error(enqueue.message),
        'Failed to start research',
        { userId: result.auth.userId, projectId: id },
      );
    }

    void logAudit('client.eng.research.started', 'ENG cabinet research started', {
      userId: result.auth.userId,
      projectId: id,
      jobId: enqueue.job.id,
    });

    // enqueueHeResearchJob общий со staff и читает джобу через `.select()`
    // целиком (researchJob.ts:50) — менять его нельзя, поэтому сужаем здесь,
    // на границе клиентского контура.
    return NextResponse.json({ ok: true, job: toClientEngJobRow(enqueue.job) });
  });
}
