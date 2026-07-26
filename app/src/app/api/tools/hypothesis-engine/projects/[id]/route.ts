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

// Без data/sample_rows — это тяжёлые jsonb-поля, деталка проекта их не тянет.
const BASE_LIST_COLUMNS = 'id, vertical_id, filename, row_count, status, analysis, created_at';
const JOB_LIST_COLUMNS = 'id, stage, status, error, attempts, started_at, finished_at';

// GET — деталка проекта: гипотезы, вертикали, цепочки, вокабуляр, базы,
// шаблоны и последние jobs. Чейн/вокаб/шаблоны привязаны к вертикалям/базам,
// поэтому догружаются второй волной по id вертикалей.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.detail' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data: project, error: projErr } = await supabaseAdmin
        .from('he_projects')
        .select('*')
        .eq('id', id)
        .single();
      if (projErr) {
        return jsonError(
          projErr.code === 'PGRST116' ? 'Проект не найден' : projErr.message,
          projErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const [hypothesesRes, verticalsRes, basesRes, jobsRes] = await Promise.all([
        supabaseAdmin
          .from('he_hypotheses')
          .select('*')
          .eq('project_id', id)
          .order('tier', { ascending: true })
          .order('potential_pct', { ascending: false }),
        supabaseAdmin
          .from('he_verticals')
          .select('*')
          .eq('project_id', id)
          .order('rank', { ascending: true }),
        supabaseAdmin
          .from('he_bases')
          .select(BASE_LIST_COLUMNS)
          .eq('project_id', id)
          .order('created_at', { ascending: false }),
        supabaseAdmin
          .from('he_jobs')
          .select(JOB_LIST_COLUMNS)
          .eq('project_id', id)
          .order('created_at', { ascending: false })
          .limit(30),
      ]);

      for (const res of [hypothesesRes, verticalsRes, basesRes, jobsRes]) {
        if (res.error) return jsonError(res.error.message, 500);
      }

      const verticals = verticalsRes.data ?? [];
      const verticalIds = verticals.map((v) => v.id as string);

      let chains: unknown[] = [];
      let vocabs: unknown[] = [];
      let templates: unknown[] = [];
      if (verticalIds.length > 0) {
        const [chainsRes, vocabsRes, templatesRes] = await Promise.all([
          supabaseAdmin
            .from('he_chains')
            .select('*')
            .in('vertical_id', verticalIds)
            .order('created_at', { ascending: false }),
          supabaseAdmin
            .from('he_vocab')
            .select('*')
            .in('vertical_id', verticalIds)
            .order('created_at', { ascending: false }),
          supabaseAdmin
            .from('he_templates')
            .select('*')
            .in('vertical_id', verticalIds)
            .order('created_at', { ascending: false }),
        ]);
        for (const res of [chainsRes, vocabsRes, templatesRes]) {
          if (res.error) return jsonError(res.error.message, 500);
        }
        chains = chainsRes.data ?? [];
        vocabs = vocabsRes.data ?? [];
        templates = templatesRes.data ?? [];
      }

      return NextResponse.json({
        project,
        hypotheses: hypothesesRes.data ?? [],
        verticals,
        chains,
        vocabs,
        bases: basesRes.data ?? [],
        templates,
        jobs: jobsRes.data ?? [],
      });
    },
  );
}

// PATCH — точечное обновление проекта. Пока поддерживается только
// offer_override: пользовательская формулировка оффера, которая ложится в
// he_projects.brief.offer_override и уточняет генерацию цепочек. Пустая
// (или состоящая из пробелов) строка удаляет ключ из brief, остальные
// ключи brief не трогаем — мержим поверх текущего значения.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.patch' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { offer_override?: unknown };
      try {
        body = (await req.json()) as { offer_override?: unknown };
      } catch {
        return jsonError('Invalid body', 400);
      }

      if (typeof body?.offer_override !== 'string') {
        return jsonError('offer_override должен быть строкой', 400);
      }

      const { data: current, error: loadErr } = await supabaseAdmin
        .from('he_projects')
        .select('brief')
        .eq('id', id)
        .single();
      if (loadErr) {
        return jsonError(
          loadErr.code === 'PGRST116' ? 'Проект не найден' : loadErr.message,
          loadErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const brief = { ...((current?.brief as Record<string, unknown> | null) ?? {}) };
      const offer = body.offer_override.trim();
      if (offer) brief.offer_override = offer;
      else delete brief.offer_override;

      const { data: project, error } = await supabaseAdmin
        .from('he_projects')
        .update({ brief })
        .eq('id', id)
        .select()
        .single();
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ project });
    },
  );
}
