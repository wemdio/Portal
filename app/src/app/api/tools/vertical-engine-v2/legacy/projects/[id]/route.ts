import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { loadLegacyArchiveProject } from '@/lib/verticalEngineV2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.legacy.project.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);
      const result = await loadLegacyArchiveProject(supabaseAdmin, id);
      if (!result.ok) {
        if (result.reason === 'not_found') return jsonError('Проект архива не найден', 404);
        return jsonError('Не удалось загрузить проект архива', 500);
      }
      return NextResponse.json({ detail: result.detail });
    },
  );
}
