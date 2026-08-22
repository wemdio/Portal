import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { listLegacyCandidates } from '@/lib/verticalEngineV2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.legacy.candidates.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (authed.auth.role !== 'admin') return jsonError('Forbidden', 403);
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const result = await listLegacyCandidates(supabaseAdmin);
      if (!result.ok) return jsonError('Не удалось загрузить legacy-кандидатов', 500);
      return NextResponse.json({ candidates: result.candidates });
    },
  );
}
