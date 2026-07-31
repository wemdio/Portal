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

// Без data — тяжёлое jsonb-поле, деталка проекта его не тянет. sample_rows
// (≤30 строк, серверный кап при записи) и columns лёгкие: шаг «База» рисует
// по ним превью первых строк на карточке. source/collect_info — прогресс-карта
// авто-сборки, бейдж «авто» и состояние retry.
const BASE_LIST_COLUMNS =
  'id, vertical_id, filename, row_count, status, analysis, source, collect_info, columns, sample_rows, created_at';
// payload нужен клиенту, чтобы привязать джобу к вертикали (payload.vertical_id) —
// иначе чужая dossier-джоба показывала бы busy/error на карточке другой вертикали.
const JOB_LIST_COLUMNS = 'id, stage, status, error, attempts, started_at, finished_at, payload, progress';
// Досье вертикалей: data — объективные счётчики сегмента, нужна на карточке.
const DOSSIER_LIST_COLUMNS = 'id, vertical_id, status, data, error';
// Банк кейсов: БЕЗ text — полный текст кейса тяжёлый, списку хватает карточки.
const CASE_LIST_COLUMNS = 'id, source, filename, industry, client_type, task, metrics, result, created_at';

// Максимум символов эталона стиля (brief.style_override) — после trim.
const STYLE_OVERRIDE_MAX_LENGTH = 8000;

// GET — деталка проекта: гипотезы, вертикали, цепочки, вокабуляр, базы,
// шаблоны, досье вертикалей, банк кейсов и последние jobs. Чейн/вокаб/шаблоны
// привязаны к вертикалям/базам, поэтому догружаются второй волной по id
// вертикалей; досье и кейсы имеют project_id и идут первой волной.
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

      const [hypothesesRes, verticalsRes, basesRes, jobsRes, dossiersRes, casesRes] = await Promise.all([
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
        supabaseAdmin
          .from('he_vertical_dossiers')
          .select(DOSSIER_LIST_COLUMNS)
          .eq('project_id', id)
          .order('created_at', { ascending: false }),
        supabaseAdmin
          .from('he_cases')
          .select(CASE_LIST_COLUMNS)
          .eq('project_id', id)
          .order('created_at', { ascending: false }),
      ]);

      for (const res of [hypothesesRes, verticalsRes, basesRes, jobsRes, dossiersRes, casesRes]) {
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
        dossiers: dossiersRes.data ?? [],
        cases: casesRes.data ?? [],
      });
    },
  );
}

// PATCH — точечное обновление проекта. Поддерживаются два необязательных
// поля (хотя бы одно обязано присутствовать): offer_override — пользовательская
// формулировка оффера и style_override — эталон стиля (1–2 «идеальных» письма,
// чью манеру имитирует генерация). Оба ложатся в he_projects.brief и уточняют
// генерацию цепочек. Пустая (или состоящая из пробелов) строка удаляет
// соответствующий ключ из brief, остальные ключи brief не трогаем — мержим
// поверх текущего значения. Незнакомые поля верхнего уровня игнорируем.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.patch' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { offer_override?: unknown; style_override?: unknown };
      try {
        body = (await req.json()) as { offer_override?: unknown; style_override?: unknown };
      } catch {
        return jsonError('Invalid body', 400);
      }

      const offerRaw = body?.offer_override;
      const styleRaw = body?.style_override;
      if (offerRaw === undefined && styleRaw === undefined) {
        return jsonError('Нужен offer_override или style_override', 400);
      }
      if (offerRaw !== undefined && typeof offerRaw !== 'string') {
        return jsonError('offer_override должен быть строкой', 400);
      }
      if (styleRaw !== undefined && typeof styleRaw !== 'string') {
        return jsonError('style_override должен быть строкой', 400);
      }
      if (typeof styleRaw === 'string' && styleRaw.trim().length > STYLE_OVERRIDE_MAX_LENGTH) {
        return jsonError(`style_override: максимум ${STYLE_OVERRIDE_MAX_LENGTH} символов`, 413);
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
      if (typeof offerRaw === 'string') {
        const offer = offerRaw.trim();
        if (offer) brief.offer_override = offer;
        else delete brief.offer_override;
      }
      if (typeof styleRaw === 'string') {
        const style = styleRaw.trim();
        if (style) brief.style_override = style;
        else delete brief.style_override;
      }

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
