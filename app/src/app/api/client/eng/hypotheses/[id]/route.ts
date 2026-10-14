import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeHypothesis, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import {
  recomputeProjectVerticalPcts,
  type RecomputedVertical,
} from '@/lib/hypothesisEngine/reviewRecompute';
import type { HeHypothesisStatus } from '@/lib/hypothesisEngine/types';
import {
  HE_HYPOTHESIS_CLIENT_COLUMNS,
  toClientEngHypothesisRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { engServerError } from '../../_shared';

export const dynamic = 'force-dynamic';

const VERDICT_SAVE_FAILED = 'Failed to save the verdict';

const VERDICTS: Record<string, HeHypothesisStatus> = {
  accept: 'accepted',
  reject: 'rejected',
};

// PATCH — разметка гипотезы с доски вертикалей кабинета: { verdict: 'accept' |
// 'reject' } → статус accepted/rejected + тот же пересчёт % и rank вертикалей
// проекта, что у staff (reviewRecompute). Скоуп — через проект-владельца.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.hypothesis.patch' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    let body: { verdict?: unknown };
    try {
      body = (await req.json()) as { verdict?: unknown };
    } catch {
      return jsonError('Invalid body', 400);
    }

    const status = typeof body?.verdict === 'string' ? VERDICTS[body.verdict] : undefined;
    if (!status) {
      return jsonError('verdict must be accept or reject', 400);
    }

    const owned = await loadClientHeHypothesis(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    // Белый список вместо `.select()`: в строке he_hypotheses едет `evidence`
    // ([{claim, source_url, quote}]) — доказательная кухня стадии, которую
    // деталка проекта клиенту не отдаёт.
    const { data: hypothesis, error } = await supabaseAdmin
      .from('he_hypotheses')
      .update({ status })
      .eq('id', id)
      .select(HE_HYPOTHESIS_CLIENT_COLUMNS)
      .single();
    if (error) {
      if (error.code === 'PGRST116') return jsonError('Hypothesis not found', 404);
      return engServerError('client.eng.hypotheses.update_failed', error, VERDICT_SAVE_FAILED, {
        userId: result.auth.userId,
        hypothesisId: id,
      });
    }

    // Статус сохранён — пересчитываем % и rank вертикалей проекта под разметку,
    // чтобы доска обновилась сразу. Ошибка пересчёта не маскирует успешный PATCH.
    let verticals: RecomputedVertical[] | null = null;
    try {
      verticals = await recomputeProjectVerticalPcts(
        supabaseAdmin,
        (hypothesis as { project_id: string }).project_id,
      );
    } catch (recomputeError) {
      await logError('client.eng.hypotheses.recompute', recomputeError);
    }

    return NextResponse.json({
      hypothesis: toClientEngHypothesisRow(hypothesis as Record<string, unknown>),
      verticals,
    });
  });
}
