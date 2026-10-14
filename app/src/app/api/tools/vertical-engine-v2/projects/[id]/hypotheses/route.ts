import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createVeManualHypothesis } from '@/lib/verticalEngineV2/manualHypotheses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const STATUS = { invalid: 400, not_found: 404, busy: 409, not_ready: 409, duplicate: 409, conflict: 409, migration: 503, db: 500 } as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.hypotheses.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
      const { id } = await params;
      let input: unknown;
      try { input = await req.json(); }
      catch { return NextResponse.json({ error: 'Некорректные данные гипотезы' }, { status: 400 }); }

      const result = await createVeManualHypothesis(supabaseAdmin, id, authed.auth.userId, input);
      if (!result.ok) {
        if (result.reason === 'db' || result.reason === 'migration') {
          await logError('tools.vertical-engine-v2.hypotheses.add_failed', new Error(result.diagnostic ?? result.message), {
            userId: authed.auth.userId, projectId: id,
          });
        }
        return NextResponse.json({ error: result.message }, { status: STATUS[result.reason] });
      }
      if (!result.existing) {
        void logAudit('tools.vertical-engine-v2.hypotheses.added', 'VE2 manual hypothesis added', {
          userId: authed.auth.userId, projectId: id, hypothesisId: result.hypothesis.id,
        });
      }
      return NextResponse.json(result);
    },
  );
}
