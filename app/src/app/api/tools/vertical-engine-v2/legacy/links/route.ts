import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { createLegacyProjectLink } from '@/lib/verticalEngineV2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.legacy.links.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (authed.auth.role !== 'admin') return jsonError('Forbidden', 403);
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      let body: {
        legacy_he_project_id?: unknown;
        review_notes?: unknown;
        backfill_batch_id?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400);
      }

      const projectId =
        typeof body.legacy_he_project_id === 'string'
          ? body.legacy_he_project_id.trim()
          : '';
      if (!UUID_RE.test(projectId)) {
        return jsonError('legacy_he_project_id должен быть UUID', 400);
      }
      if (body.review_notes !== undefined && typeof body.review_notes !== 'string') {
        return jsonError('review_notes должен быть строкой', 400);
      }
      if (
        body.backfill_batch_id !== undefined &&
        typeof body.backfill_batch_id !== 'string'
      ) {
        return jsonError('backfill_batch_id должен быть строкой', 400);
      }

      const result = await createLegacyProjectLink(supabaseAdmin, {
        projectId,
        verifiedBy: authed.auth.userId,
        reviewNotes:
          typeof body.review_notes === 'string'
            ? body.review_notes.trim().slice(0, 2000) || null
            : null,
        backfillBatchId:
          typeof body.backfill_batch_id === 'string'
            ? body.backfill_batch_id.trim().slice(0, 200) || null
            : null,
      });
      if (!result.ok) {
        if (result.reason === 'not_found') return jsonError('Legacy-проект не найден', 404);
        if (result.reason === 'exists') return jsonError('Проект уже добавлен в архив', 409);
        await logError('tools.vertical-engine-v2.legacy.links.create_failed', result.message, {
          userId: authed.auth.userId,
          projectId,
        });
        return jsonError('Не удалось добавить проект в архив', 500);
      }

      void logAudit(
        'tools.vertical-engine-v2.legacy.links.created',
        'Legacy project approved for Vertical Engine v2 archive',
        {
          userId: authed.auth.userId,
          legacyProjectId: projectId,
        },
      );
      return NextResponse.json({ link: result.link }, { status: 201 });
    },
  );
}
