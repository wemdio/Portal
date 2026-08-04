import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import { loadClientHeHypothesis } from '@/lib/hypothesisEngine/apiGuards';
import {
  recomputeProjectVerticalPcts,
  type RecomputedVertical,
} from '@/lib/hypothesisEngine/reviewRecompute';
import type { HeHypothesisStatus } from '@/lib/hypothesisEngine/types';

export const dynamic = 'force-dynamic';

const VERDICTS: Record<string, HeHypothesisStatus> = {
  accept: 'accepted',
  reject: 'rejected',
};

// PATCH — разметка гипотезы с доски вертикалей кабинета: { verdict: 'accept' |
// 'reject' } → статус accepted/rejected + тот же пересчёт % и rank вертикалей
// проекта, что у staff (reviewRecompute). Скоуп — через проект-владельца.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

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

  const { data: hypothesis, error } = await supabaseAdmin
    .from('he_hypotheses')
    .update({ status })
    .eq('id', id)
    .select()
    .single();
  if (error) {
    return jsonError(
      error.code === 'PGRST116' ? 'Hypothesis not found' : error.message,
      error.code === 'PGRST116' ? 404 : 500,
    );
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

  return NextResponse.json({ hypothesis, verticals });
}
