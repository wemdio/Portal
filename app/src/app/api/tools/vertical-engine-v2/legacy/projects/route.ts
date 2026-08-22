import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { listLegacyArchiveProjects } from '@/lib/verticalEngineV2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.legacy.projects.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const result = await listLegacyArchiveProjects(supabaseAdmin);
      if (!result.ok) return jsonError('Не удалось загрузить архив', 500);
      return NextResponse.json({ projects: result.projects });
    },
  );
}
