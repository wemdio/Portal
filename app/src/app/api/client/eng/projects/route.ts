import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { normalizeWebsiteInput } from '@/lib/hypothesisEngine/websiteUrl';
import { enqueueHeResearchJob } from '@/lib/hypothesisEngine/researchJob';

export const dynamic = 'force-dynamic';
// normalizeWebsiteInput тянет node:url (domainToUnicode) — как у staff-роута.
export const runtime = 'nodejs';

/**
 * Клиентский ENG-контур «Движка вертикалей» (кабинет с EN-UI):
 * проекты всегда market='us' и строго свои (created_by = user id).
 * TODO(tariffs): гейт доступа по тарифу/флагу — сейчас раздел открыт любому
 * клиенту, заводим вместе с тарифной обвязкой ENG-продукта.
 */

// GET — список СВОИХ проектов со счётчиками вертикалей и баз.
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { data: projects, error } = await supabaseAdmin
    .from('he_projects')
    .select('id, created_by, name, website_url, status, market, error, created_at, updated_at')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return jsonError(error.message, 500);

  const rows = projects ?? [];
  const verticalCounts = new Map<string, number>();
  const baseCounts = new Map<string, number>();
  if (rows.length > 0) {
    const ids = rows.map((p) => p.id as string);
    const [verticalsRes, basesRes] = await Promise.all([
      supabaseAdmin.from('he_verticals').select('project_id').in('project_id', ids),
      supabaseAdmin.from('he_bases').select('project_id').in('project_id', ids),
    ]);
    if (verticalsRes.error) return jsonError(verticalsRes.error.message, 500);
    if (basesRes.error) return jsonError(basesRes.error.message, 500);
    for (const v of verticalsRes.data ?? []) {
      const pid = v.project_id as string;
      verticalCounts.set(pid, (verticalCounts.get(pid) ?? 0) + 1);
    }
    for (const b of basesRes.data ?? []) {
      const pid = b.project_id as string;
      baseCounts.set(pid, (baseCounts.get(pid) ?? 0) + 1);
    }
  }

  return NextResponse.json({
    projects: rows.map((p) => ({
      ...p,
      vertical_count: verticalCounts.get(p.id as string) ?? 0,
      base_count: baseCounts.get(p.id as string) ?? 0,
    })),
  });
}

// POST — создать проект { website_url, name? }: market='us' принудительно,
// имя по умолчанию — hostname; research (site_profile) ставится сразу,
// чтобы мастер кабинета начинал с прогресса исследования.
export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  let body: { website_url?: unknown; name?: unknown };
  try {
    body = (await req.json()) as { website_url?: unknown; name?: unknown };
  } catch {
    return jsonError('Invalid body', 400);
  }

  const rawUrl = typeof body?.website_url === 'string' ? body.website_url : '';
  const normalized = normalizeWebsiteInput(rawUrl);
  if (!normalized) {
    return jsonError('Invalid website_url — enter the domain or URL of your site', 400);
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
      market: 'us',
    })
    .select()
    .single();
  if (error || !project) {
    await logError('client.eng.projects.create_failed', error, { userId });
    return jsonError(error?.message ?? 'Failed to create the project', 500);
  }

  // Для свежего проекта активных research-джоб нет — конфликт невозможен,
  // но постановку делаем тем же helper'ом, что и «Re-run research».
  const enqueue = await enqueueHeResearchJob(supabaseAdmin, project.id as string);
  if (!enqueue.ok) {
    await logError('client.eng.projects.research_enqueue_failed', new Error(enqueue.message), {
      userId,
      projectId: project.id,
    });
    return jsonError(enqueue.message ?? 'Failed to start research', 500);
  }

  void logAudit('client.eng.projects.created', 'ENG cabinet project created', {
    userId,
    projectId: project.id,
    websiteUrl: normalized.url,
  });

  return NextResponse.json(
    { project: { ...project, status: 'researching', error: null }, job: enqueue.job },
    { status: 201 },
  );
}
