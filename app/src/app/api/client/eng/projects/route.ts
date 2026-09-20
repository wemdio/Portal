import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit } from '@/lib/loggerServer';
import { withToolTrace } from '@/lib/toolTrace';
import { requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { normalizeWebsiteInput } from '@/lib/hypothesisEngine/websiteUrl';
import { enqueueHeResearchJob } from '@/lib/hypothesisEngine/researchJob';
import {
  HE_PROJECT_CLIENT_COLUMNS,
  toClientEngJobRow,
  toClientEngProjectRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { engServerError } from '../_shared';

export const dynamic = 'force-dynamic';
// normalizeWebsiteInput тянет node:url (domainToUnicode) — как у staff-роута.
export const runtime = 'nodejs';

/**
 * Клиентский ENG-контур «Движка вертикалей» (кабинет с EN-UI):
 * проекты всегда market='us' и строго свои (created_by = user id).
 * TODO(tariffs): гейт доступа по тарифу/флагу — сейчас раздел открыт любому
 * ENG-клиенту, заводим вместе с тарифной обвязкой ENG-продукта. Рыночный гейт
 * (ru-клиент сюда не ходит) уже стоит — requireEngMarket.
 */

/** Тексты 5xx — константы контура: ни Postgres, ни провайдер наружу не едут. */
const PROJECTS_LOAD_FAILED = 'Failed to load your projects';
const PROJECT_CREATE_FAILED = 'Failed to create the project';
const RESEARCH_START_FAILED = 'Failed to start research';

// GET — список СВОИХ проектов со счётчиками вертикалей и баз.
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const gate = await requireEngMarket(supabaseAdmin, userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  // Тот же белый список, что и у проектора: свой набор колонок в роуте — это
  // копия, которая рано или поздно разойдётся. `created_by` из выборки убран:
  // он только фильтр (ниже), в ответе его никто не читал.
  const { data: projects, error } = await supabaseAdmin
    .from('he_projects')
    .select(HE_PROJECT_CLIENT_COLUMNS)
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return engServerError('client.eng.projects.list_failed', error, PROJECTS_LOAD_FAILED, { userId });

  const rows = projects ?? [];
  const verticalCounts = new Map<string, number>();
  const baseCounts = new Map<string, number>();
  if (rows.length > 0) {
    const ids = rows.map((p) => p.id as string);
    const [verticalsRes, basesRes] = await Promise.all([
      supabaseAdmin.from('he_verticals').select('project_id').in('project_id', ids),
      supabaseAdmin.from('he_bases').select('project_id').in('project_id', ids),
    ]);
    if (verticalsRes.error) {
      return engServerError('client.eng.projects.list_failed', verticalsRes.error, PROJECTS_LOAD_FAILED, { userId });
    }
    if (basesRes.error) {
      return engServerError('client.eng.projects.list_failed', basesRes.error, PROJECTS_LOAD_FAILED, { userId });
    }
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
      ...toClientEngProjectRow(p as Record<string, unknown>),
      vertical_count: verticalCounts.get(p.id as string) ?? 0,
      base_count: baseCounts.get(p.id as string) ?? 0,
    })),
  });
}

// POST — создать проект { website_url, name? }: market='us' принудительно,
// имя по умолчанию — hostname; research (site_profile) ставится сразу,
// чтобы мастер кабинета начинал с прогресса исследования.
export async function POST(req: NextRequest) {
  // Трассируем только мутирующие роуты кабинета: withToolTrace — это INSERT +
  // UPDATE в trace_spans вокруг каждого запроса, а мастер и дашборд поллят
  // свои GET'ы каждые 4 и 15 секунд (EngProjectWizard/EngDashboard).
  return withToolTrace({ request: req, operation: 'client.eng.projects.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { userId } = result.auth;
    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

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
      .select(HE_PROJECT_CLIENT_COLUMNS)
      .single();
    if (error || !project) {
      return engServerError('client.eng.projects.create_failed', error, PROJECT_CREATE_FAILED, { userId });
    }

    // Для свежего проекта активных research-джоб нет — конфликт невозможен,
    // но постановку делаем тем же helper'ом, что и «Re-run research».
    const enqueue = await enqueueHeResearchJob(supabaseAdmin, project.id as string);
    if (!enqueue.ok) {
      return engServerError(
        'client.eng.projects.research_enqueue_failed',
        new Error(enqueue.message),
        RESEARCH_START_FAILED,
        { userId, projectId: project.id },
      );
    }

    void logAudit('client.eng.projects.created', 'ENG cabinet project created', {
      userId,
      projectId: project.id,
      websiteUrl: normalized.url,
    });

    return NextResponse.json(
      {
        // Проекция как у деталки: в строке из insert().select() едут
        // cost_usd/tokens_used/llm_model, кабинету они не нужны. Причина
        // падения — код (`error_code`), а не текст стадии; у свежего проекта
        // её нет.
        project: {
          ...toClientEngProjectRow(project as Record<string, unknown>),
          status: 'researching',
          error_code: null,
        },
        // enqueueHeResearchJob общий со staff и читает джобу целиком
        // (researchJob.ts:50) — сужаем на границе контура.
        job: toClientEngJobRow(enqueue.job),
      },
      { status: 201 },
    );
  });
}
