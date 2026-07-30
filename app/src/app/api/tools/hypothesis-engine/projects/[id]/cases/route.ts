import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { structureCaseText } from '@/lib/hypothesisEngine/caseBank';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// POST дергает LLM-структуризацию текста кейса — держим запас над 30s дефолтом соседей.
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const MAX_TEXT_CHARS = 20000;

// Лёгкая проекция для списков/ответов: без text/metrics (тяжёлые поля).
const CASE_LIST_COLUMNS = 'id, source, filename, industry, client_type, result, created_at';

// GET — список кейсов проекта (и site-, и upload-источники).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.cases.list' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data, error } = await supabaseAdmin
        .from('he_cases')
        .select(CASE_LIST_COLUMNS)
        .eq('project_id', id)
        .order('created_at', { ascending: false });
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ cases: data ?? [] });
    },
  );
}

// POST — вставка кейса текстом (экспорт из PDF и т.п.): LLM-структуризация →
// he_cases с source='upload'. Сайт-стадия такие кейсы никогда не перезаписывает.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.cases.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { text?: unknown; filename?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400);
      }

      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) return jsonError('text должен быть непустой строкой', 400);
      if (text.length > MAX_TEXT_CHARS) {
        return jsonError(`Слишком длинный текст: ${text.length} символов. Максимум — ${MAX_TEXT_CHARS}`, 413);
      }

      const filename =
        typeof body?.filename === 'string' && body.filename.trim()
          ? body.filename.trim().slice(0, 500)
          : null;

      // Проект существует?
      const { error: projErr } = await supabaseAdmin
        .from('he_projects')
        .select('id')
        .eq('id', id)
        .single();
      if (projErr) {
        return jsonError(
          projErr.code === 'PGRST116' ? 'Проект не найден' : projErr.message,
          projErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      let structured;
      try {
        structured = await structureCaseText(text);
      } catch (e) {
        await logError('tools.hypothesis-engine.cases.structure_failed', e, { userId, projectId: id });
        return jsonError('Не удалось разобрать текст кейса', 502);
      }

      const { data: caseRow, error: caseErr } = await supabaseAdmin
        .from('he_cases')
        .insert({
          project_id: id,
          source: 'upload',
          filename,
          industry: structured.industry,
          client_type: structured.client_type,
          task: structured.task,
          metrics: structured.metrics,
          result: structured.result,
          text: structured.text,
        })
        .select(CASE_LIST_COLUMNS)
        .single();
      if (caseErr || !caseRow) {
        await logError('tools.hypothesis-engine.cases.insert_failed', caseErr, { userId, projectId: id });
        return jsonError(caseErr?.message ?? 'Не удалось сохранить кейс', 500);
      }

      void logAudit('tools.hypothesis-engine.cases.uploaded', 'Hypothesis engine case uploaded', {
        userId,
        projectId: id,
        caseId: (caseRow as { id?: string }).id,
        filename,
      });

      return NextResponse.json({ case: caseRow }, { status: 201 });
    },
  );
}

// DELETE — удаление кейса проекта: id из query (?id=…) или из body {id}.
// Кейс обязан принадлежать этому проекту; источник (site/upload) не ограничен —
// проект принадлежит специалисту.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.cases.delete' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      // req.url (а не req.nextUrl): так работает и в next, и в node-тестах.
      let caseId = new URL(req.url).searchParams.get('id') ?? '';
      if (!caseId) {
        try {
          const body = (await req.json()) as { id?: unknown };
          caseId = typeof body?.id === 'string' ? body.id : '';
        } catch {
          /* тела нет — ок, id мог быть только в query */
        }
      }
      if (!caseId) return jsonError('Укажите id кейса', 400);

      const { data: deleted, error } = await supabaseAdmin
        .from('he_cases')
        .delete()
        .eq('id', caseId)
        .eq('project_id', id)
        .select('id');
      if (error) return jsonError(error.message, 500);
      if (!deleted?.length) return jsonError('Кейс не найден в этом проекте', 404);

      return NextResponse.json({ ok: true });
    },
  );
}
