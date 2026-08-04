import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { loadClientHeProject } from '@/lib/hypothesisEngine/apiGuards';
import { enqueueHeResearchJob } from '@/lib/hypothesisEngine/researchJob';

export const dynamic = 'force-dynamic';

// POST — перезапустить research-пайплайн СВОЕГО проекта (кнопка «Re-run
// research» шага Brief). Дедуп тот же, что у staff: активная research-стадия → 409.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const enqueue = await enqueueHeResearchJob(supabaseAdmin, id);
  if (!enqueue.ok) {
    if (enqueue.reason === 'conflict') {
      return jsonError('Research is already running for this project', 409);
    }
    await logError('client.eng.research.enqueue_failed', new Error(enqueue.message), {
      userId: result.auth.userId,
      projectId: id,
    });
    return jsonError(enqueue.message ?? 'Failed to start research', 500);
  }

  void logAudit('client.eng.research.started', 'ENG cabinet research started', {
    userId: result.auth.userId,
    projectId: id,
    jobId: enqueue.job.id,
  });

  return NextResponse.json({ ok: true, job: enqueue.job });
}
