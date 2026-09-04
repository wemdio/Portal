import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  MAX_CASE_TEXT_CHARS,
  VeCaseImportIncompleteError,
  structureCaseTexts,
  validateCaseDrafts,
} from '@/lib/verticalEngineV2/caseBank';
import { VE_CASE_LIST_COLUMNS } from '@/lib/verticalEngineV2/projectDetail';
import { withVeDeadline } from '@/lib/verticalEngineV2/operationDeadline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// POST дергает LLM-структуризацию текста кейса — держим запас над 30s дефолтом соседей.
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// GET — список кейсов проекта (и site-, и upload-источники).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.cases.list' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data, error } = await supabaseAdmin
        .from('ve_cases')
        .select(VE_CASE_LIST_COLUMNS)
        .eq('project_id', id)
        .order('created_at', { ascending: false });
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ cases: data ?? [] });
    },
  );
}

// preview разбирает текст без записи; save сохраняет выбранные проверенные кейсы
// без повторного LLM-вызова. Старый POST без mode разбирает и сохраняет весь набор.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.cases.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { text?: unknown; filename?: unknown; mode?: unknown; cases?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400);
      }

      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) return jsonError('text должен быть непустой строкой', 400);
      if (text.length > MAX_CASE_TEXT_CHARS) {
        return jsonError(`Слишком длинный текст: ${text.length} символов. Максимум: ${MAX_CASE_TEXT_CHARS}`, 413);
      }
      const mode = body?.mode ?? 'import';
      if (mode !== 'preview' && mode !== 'save' && mode !== 'import') {
        return jsonError('Неизвестное действие с кейсами', 400);
      }

      const filename =
        typeof body?.filename === 'string' && body.filename.trim()
          ? body.filename.trim().slice(0, 500)
          : null;

      // Проект существует?
      const { error: projErr } = await supabaseAdmin
        .from('ve_projects')
        .select('id')
        .eq('id', id)
        .single();
      if (projErr) {
        return jsonError(
          projErr.code === 'PGRST116' ? 'Проект не найден' : projErr.message,
          projErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      let drafts;
      if (mode === 'save') {
        try {
          drafts = validateCaseDrafts(text, body.cases);
        } catch {
          return jsonError('Разбор не соответствует исходному тексту. Вернитесь к тексту и разберите кейсы заново.', 422);
        }
      } else {
        try {
          drafts = await withVeDeadline('Case parsing', 45_000, req.signal, (signal) => structureCaseTexts(text, signal));
        } catch (e) {
          await logError('tools.vertical-engine-v2.cases.structure_failed', e, { userId, projectId: id });
          if (e instanceof VeCaseImportIncompleteError) return jsonError(e.message, 502);
          return jsonError('Не удалось полностью и надёжно разобрать кейсы. Разделите текст на меньшие части, укажите клиента, задачу и результат каждого кейса и повторите разбор.', 502);
        }
      }

      if (mode === 'preview') {
        return NextResponse.json({ cases: drafts, count: drafts.length });
      }
      if (!drafts.length) {
        return jsonError('Нет кейсов для сохранения. Добавьте описание конкретного клиента, выполненной работы и результата.', 422);
      }
      if (req.signal.aborted) return jsonError('Добавление кейсов отменено', 409);

      // Один batch insert: весь выбранный набор сохраняется одним SQL-запросом.
      const { data: caseRows, error: caseErr } = await supabaseAdmin
        .from('ve_cases')
        .insert(drafts.map((draft) => ({
          project_id: id,
          source: 'upload',
          filename,
          industry: draft.industry,
          client_type: draft.client_type,
          task: draft.task,
          metrics: draft.metrics,
          result: draft.result,
          text: draft.text,
        })))
        .select(VE_CASE_LIST_COLUMNS);
      if (caseErr || !caseRows?.length) {
        await logError('tools.vertical-engine-v2.cases.insert_failed', caseErr, { userId, projectId: id });
        return jsonError(caseErr?.message ?? 'Не удалось сохранить кейсы', 500);
      }

      void logAudit('tools.vertical-engine-v2.cases.uploaded', 'Vertical engine cases added', {
        userId,
        projectId: id,
        caseIds: caseRows.map((row: { id: string }) => row.id),
        count: caseRows.length,
        filename,
      });

      // case остаётся для старых клиентов; новый UI использует cases и count.
      return NextResponse.json({ cases: caseRows, count: caseRows.length, case: caseRows[0] }, { status: 201 });
    },
  );
}

// DELETE — удаление кейса проекта: id из query (?id=…) или из body {id}.
// Кейс обязан принадлежать этому проекту; источник (site/upload) не ограничен —
// проект принадлежит специалисту.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.cases.delete' },
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
        .from('ve_cases')
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
