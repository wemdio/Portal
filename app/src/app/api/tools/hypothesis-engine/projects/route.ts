import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// GET — список проектов всех internal-пользователей (инструмент общий),
// с количеством вертикалей по каждому проекту.
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { data: projects, error } = await supabaseAdmin
        .from('he_projects')
        .select('id, created_by, name, website_url, status, error, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) return jsonError(error.message, 500);

      const rows = projects ?? [];
      const counts = new Map<string, number>();
      if (rows.length > 0) {
        const { data: verticals, error: vertErr } = await supabaseAdmin
          .from('he_verticals')
          .select('project_id')
          .in('project_id', rows.map((p) => p.id as string));
        if (vertErr) return jsonError(vertErr.message, 500);
        for (const v of verticals ?? []) {
          const pid = v.project_id as string;
          counts.set(pid, (counts.get(pid) ?? 0) + 1);
        }
      }

      return NextResponse.json({
        projects: rows.map((p) => ({
          ...p,
          vertical_count: counts.get(p.id as string) ?? 0,
        })),
      });
    },
  );
}

// POST — создание новых прогонов переехало в v2 (/tools/vertical-engine-v2).
// Этот инструмент работает только с уже созданными проектами. ENG-контур
// (/api/client/eng/projects) не затрагивается.
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;

      return NextResponse.json(
        {
          error:
            'Новые прогоны создаются в Движке вертикалей v2 (/tools/vertical-engine-v2). Этот инструмент — только просмотр существующих проектов.',
          code: 'MIGRATED_TO_V2',
        },
        { status: 409 },
      );
    },
  );
}
