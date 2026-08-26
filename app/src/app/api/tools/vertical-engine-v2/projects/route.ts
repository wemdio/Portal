import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeWebsiteInput } from '@/lib/verticalEngineV2/websiteUrl';
import { findInternalLegacyDuplicates } from '@/lib/verticalEngineV2/legacyDuplicateCheck';

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
    { request: req, operation: 'tools.vertical-engine-v2.projects.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { data: projects, error } = await supabaseAdmin
        .from('ve_projects')
        .select('id, created_by, name, website_url, status, error, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) return jsonError(error.message, 500);

      const rows = projects ?? [];
      const counts = new Map<string, number>();
      if (rows.length > 0) {
        const { data: verticals, error: vertErr } = await supabaseAdmin
          .from('ve_verticals')
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
        permissions: { can_manage_legacy_links: authed.auth.role === 'admin' },
      });
    },
  );
}

// POST — создать проект: { website_url, name? }. Имя по умолчанию — hostname.
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.projects.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      let body: { website_url?: unknown; name?: unknown; confirm?: unknown };
      try {
        body = (await req.json()) as { website_url?: unknown; name?: unknown; confirm?: unknown };
      } catch {
        return jsonError('Invalid body', 400);
      }

      const rawUrl = typeof body?.website_url === 'string' ? body.website_url : '';
      const normalized = normalizeWebsiteInput(rawUrl);
      if (!normalized) {
        return jsonError('Некорректный website_url — укажите домен или URL сайта клиента', 400);
      }

      // Блокировка дублей с v1: сверяемся с внутренними he_projects по домену.
      // Без явного confirm при найденных дублях отвечаем 409 (UI показывает
      // предупреждение и повторяет запрос с confirm=true).
      const confirm = typeof body?.confirm === 'boolean' ? body.confirm : false;
      if (!confirm) {
        const dups = await findInternalLegacyDuplicates(supabaseAdmin, normalized.hostname);
        if (dups.length > 0) {
          return NextResponse.json(
            {
              error: 'Этот сайт уже прогоняли в Движке вертикалей v1.',
              code: 'LEGACY_DUPLICATE',
              conflict: { domain: normalized.hostname, legacy_projects: dups },
            },
            { status: 409 },
          );
        }
      }

      const name =
        typeof body?.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 300)
          : normalized.hostname;

      const { data: project, error } = await supabaseAdmin
        .from('ve_projects')
        .insert({
          created_by: userId,
          name,
          website_url: normalized.url,
          status: 'draft',
        })
        .select()
        .single();
      if (error || !project) {
        await logError('tools.vertical-engine-v2.projects.create_failed', error, { userId });
        return jsonError(error?.message ?? 'Не удалось создать проект', 500);
      }

      void logAudit('tools.vertical-engine-v2.projects.created', 'Hypothesis engine project created', {
        userId,
        projectId: project.id,
        websiteUrl: normalized.url,
      });

      return NextResponse.json({ project }, { status: 201 });
    },
  );
}
