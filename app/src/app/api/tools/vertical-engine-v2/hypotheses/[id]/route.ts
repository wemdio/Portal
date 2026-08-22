import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import {
  recomputeProjectVerticalPcts,
  type RecomputedVertical,
} from '@/lib/verticalEngineV2/reviewRecompute';
import type { VeHypothesisStatus } from '@/lib/verticalEngineV2/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const STATUSES: VeHypothesisStatus[] = ['proposed', 'accepted', 'rejected'];

// PATCH — смена статуса гипотезы с доски вертикалей (кнопки accept/reject).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.hypotheses.patch' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { status?: unknown };
      try {
        body = (await req.json()) as { status?: unknown };
      } catch {
        return jsonError('Invalid body', 400);
      }

      if (typeof body?.status !== 'string' || !STATUSES.includes(body.status as VeHypothesisStatus)) {
        return jsonError('status должен быть proposed, accepted или rejected', 400);
      }

      const { data: hypothesis, error } = await supabaseAdmin
        .from('ve_hypotheses')
        .update({ status: body.status as VeHypothesisStatus })
        .eq('id', id)
        .select()
        .single();
      if (error) {
        return jsonError(
          error.code === 'PGRST116' ? 'Гипотеза не найдена' : error.message,
          error.code === 'PGRST116' ? 404 : 500,
        );
      }

      // Статус сохранён — пересчитываем % и rank вертикалей проекта под
      // разметку, чтобы доска обновилась сразу. Ошибка пересчёта не маскирует
      // успешный PATCH: доска просто подтянет актуальные данные позже.
      let verticals: RecomputedVertical[] | null = null;
      try {
        verticals = await recomputeProjectVerticalPcts(
          supabaseAdmin,
          (hypothesis as { project_id: string }).project_id,
        );
      } catch (recomputeError) {
        await logError('vertical-engine-v2.hypotheses.recompute', recomputeError);
      }

      return NextResponse.json({ hypothesis, verticals });
    },
  );
}
