import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeBase, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import {
  HE_JOB_CLIENT_COLUMNS,
  toClientEngJobRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const TEMPLATE_START_FAILED = 'Failed to start the template';

// POST — поставить генерацию шаблона 85/15 по СВОЕЙ проанализированной базе.
// База должна пройти анализ (status='analyzed'), иначе 409. Дедуп как у
// staff: активная template-задача на эту базу уже есть → 200 с ней же.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.template.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeBase(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    if ((owned.base as { status?: string }).status !== 'analyzed') {
      return jsonError('The base is not analyzed yet — wait for the analysis to finish', 409);
    }

    const { data: active, error: activeErr } = await supabaseAdmin
      .from('he_jobs')
      .select(HE_JOB_CLIENT_COLUMNS)
      .eq('project_id', owned.base.project_id as string)
      .eq('stage', 'template')
      .in('status', ['pending', 'running']);
    if (activeErr) {
      return engServerError('client.eng.template.active_lookup_failed', activeErr, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }
    const existing = (active ?? []).find(
      (j) => (j.payload as { base_id?: string } | null)?.base_id === id,
    );
    if (existing) return NextResponse.json({ ok: true, job: toClientEngJobRow(existing) });

    // `.select()` без аргументов вернул бы строку he_jobs целиком, вместе с
    // tokens_used/cost_usd и сырым текстом error: обе ветки роута отдают
    // джобу клиенту, значит и читать они обязаны одинаково.
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('he_jobs')
      .insert({
        project_id: owned.base.project_id as string,
        stage: 'template',
        status: 'pending',
        payload: { base_id: id },
      })
      .select(HE_JOB_CLIENT_COLUMNS)
      .single();
    if (jobErr || !job) {
      return engServerError('client.eng.template.enqueue_failed', jobErr, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }

    void logAudit('client.eng.template.enqueued', 'ENG cabinet template enqueued', {
      userId: result.auth.userId,
      baseId: id,
      jobId: job.id,
    });

    return NextResponse.json({ ok: true, job: toClientEngJobRow(job) }, { status: 201 });
  });
}
