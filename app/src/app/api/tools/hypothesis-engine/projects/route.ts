import { domainToUnicode } from 'node:url';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Нормализация сайта клиента: «example.com» → «https://example.com/».
 * Проверка минимальная (протокол http/https + валидный hostname с точкой) —
 * реальная доступность сайта выяснится воркером на стадии site_profile.
 */
function normalizeWebsiteInput(raw: string): { url: string; hostname: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)) return null;
  if (!hostname.includes('.') || hostname.includes('..')) return null;
  // IDN-домены (например кириллические .рф) храним в Unicode, а не в punycode
  // («xn--…») — иначе закодированный вид торчит в интерфейсе, имени проекта
  // по умолчанию и в промптах. Фетч воркера сам перекодирует при запросе.
  const unicodeHostname = domainToUnicode(hostname) || hostname;
  const url =
    unicodeHostname === hostname
      ? parsed.href
      : `${parsed.protocol}//${unicodeHostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return { url, hostname: unicodeHostname };
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

// POST — создать проект: { website_url, name? }. Имя по умолчанию — hostname.
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      let body: { website_url?: unknown; name?: unknown };
      try {
        body = (await req.json()) as { website_url?: unknown; name?: unknown };
      } catch {
        return jsonError('Invalid body', 400);
      }

      const rawUrl = typeof body?.website_url === 'string' ? body.website_url : '';
      const normalized = normalizeWebsiteInput(rawUrl);
      if (!normalized) {
        return jsonError('Некорректный website_url — укажите домен или URL сайта клиента', 400);
      }

      const name =
        typeof body?.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 300)
          : normalized.hostname;

      const { data: project, error } = await supabaseAdmin
        .from('he_projects')
        .insert({
          created_by: userId,
          name,
          website_url: normalized.url,
          status: 'draft',
        })
        .select()
        .single();
      if (error || !project) {
        await logError('tools.hypothesis-engine.projects.create_failed', error, { userId });
        return jsonError(error?.message ?? 'Не удалось создать проект', 500);
      }

      void logAudit('tools.hypothesis-engine.projects.created', 'Hypothesis engine project created', {
        userId,
        projectId: project.id,
        websiteUrl: normalized.url,
      });

      return NextResponse.json({ project }, { status: 201 });
    },
  );
}
