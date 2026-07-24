import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { HeHypothesisStatus } from '@/lib/hypothesisEngine/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const STATUSES: HeHypothesisStatus[] = ['proposed', 'accepted', 'rejected'];

// PATCH — смена статуса гипотезы с доски вертикалей (кнопки accept/reject).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.hypotheses.patch' },
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

      if (typeof body?.status !== 'string' || !STATUSES.includes(body.status as HeHypothesisStatus)) {
        return jsonError('status должен быть proposed, accepted или rejected', 400);
      }

      const { data: hypothesis, error } = await supabaseAdmin
        .from('he_hypotheses')
        .update({ status: body.status as HeHypothesisStatus })
        .eq('id', id)
        .select()
        .single();
      if (error) {
        return jsonError(
          error.code === 'PGRST116' ? 'Гипотеза не найдена' : error.message,
          error.code === 'PGRST116' ? 404 : 500,
        );
      }

      return NextResponse.json({ hypothesis });
    },
  );
}
