import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { removeLegacyProjectLink } from '@/lib/verticalEngineV2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.legacy.links.delete' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (authed.auth.role !== 'admin') return jsonError('Forbidden', 403);
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);
      const result = await removeLegacyProjectLink(supabaseAdmin, id);
      if (!result.ok) {
        await logError('tools.vertical-engine-v2.legacy.links.delete_failed', result.message, {
          userId: authed.auth.userId,
          projectId: id,
        });
        return jsonError('Не удалось удалить проект из архива', 500);
      }

      void logAudit(
        'tools.vertical-engine-v2.legacy.links.deleted',
        'Legacy project removed from Vertical Engine v2 archive',
        {
          userId: authed.auth.userId,
          legacyProjectId: id,
        },
      );
      return NextResponse.json({ ok: true });
    },
  );
}
