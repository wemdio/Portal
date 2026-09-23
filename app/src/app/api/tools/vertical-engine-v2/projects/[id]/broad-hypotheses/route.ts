import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { enqueueVeBroadHypothesesJob } from '@/lib/verticalEngineV2/broadHypothesesJob';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const STATUS = { not_found: 404, busy: 409, not_ready: 409, limit: 409, db: 500 } as const;

// POST — добавить широкие гипотезы в уже исследованный проект. Ставит задачу
// воркера (стадия broad_hypotheses); существующие гипотезы, вертикали, базы и
// выбор не меняются. Пока задача идёт, повторный POST возвращает её же.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.broad-hypotheses.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

      const { id } = await params;
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

      const result = await enqueueVeBroadHypothesesJob(supabaseAdmin, id);
      if (!result.ok) {
        if (result.reason === 'db') {
          await logError('tools.vertical-engine-v2.broad-hypotheses.enqueue_failed', new Error(result.message), {
            userId,
            projectId: id,
          });
        }
        return NextResponse.json({ error: result.message }, { status: STATUS[result.reason] });
      }

      if (!result.existing) {
        void logAudit('tools.vertical-engine-v2.broad-hypotheses.started', 'VE2 broad hypotheses requested', {
          userId,
          projectId: id,
          jobId: result.job.id,
        });
      }
      return NextResponse.json({ ok: true, job: result.job, existing: result.existing });
    },
  );
}
