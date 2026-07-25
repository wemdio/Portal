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

const MAX_ROWS = 10000;
const SAMPLE_ROWS = 30;

// POST — загрузка базы специалиста под вертикаль (строки парсятся из CSV/XLSX
// на клиенте, как в /client/launch). После сохранения ставится стадия
// base_analyze — профиль базы считает воркер.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.bases.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: {
        vertical_id?: unknown;
        filename?: unknown;
        columns?: unknown;
        rows?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400);
      }

      const verticalId = typeof body?.vertical_id === 'string' ? body.vertical_id : '';
      if (!verticalId) return jsonError('Укажите vertical_id', 400);

      const columns = Array.isArray(body?.columns)
        ? (body.columns as unknown[]).filter((c): c is string => typeof c === 'string')
        : null;
      if (!columns || columns.length === 0) {
        return jsonError('columns должен быть непустым массивом строк', 400);
      }

      if (!Array.isArray(body?.rows) || body.rows.length === 0) {
        return jsonError('rows должен быть непустым массивом объектов', 400);
      }
      const rows = body.rows as Array<Record<string, unknown>>;
      if (rows.length > MAX_ROWS) {
        return jsonError(`Слишком много строк: ${rows.length}. Максимум — ${MAX_ROWS}`, 413);
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

      // Вертикаль принадлежит именно этому проекту?
      const { error: vertErr } = await supabaseAdmin
        .from('he_verticals')
        .select('id')
        .eq('id', verticalId)
        .eq('project_id', id)
        .single();
      if (vertErr) {
        return jsonError(
          vertErr.code === 'PGRST116' ? 'Вертикаль не найдена в этом проекте' : vertErr.message,
          vertErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const { data: base, error: baseErr } = await supabaseAdmin
        .from('he_bases')
        .insert({
          project_id: id,
          vertical_id: verticalId,
          filename,
          row_count: rows.length,
          columns,
          sample_rows: rows.slice(0, SAMPLE_ROWS),
          data: rows,
          status: 'uploaded',
        })
        .select('id, status')
        .single();
      if (baseErr || !base) {
        await logError('tools.hypothesis-engine.bases.insert_failed', baseErr, { userId, projectId: id });
        return jsonError(baseErr?.message ?? 'Не удалось сохранить базу', 500);
      }

      const { error: jobErr } = await supabaseAdmin
        .from('he_jobs')
        .insert({
          project_id: id,
          stage: 'base_analyze',
          status: 'pending',
          payload: { base_id: base.id },
        });
      if (jobErr) {
        await logError('tools.hypothesis-engine.bases.enqueue_failed', jobErr, {
          userId,
          projectId: id,
          baseId: base.id,
        });
        return jsonError(jobErr.message, 500);
      }

      void logAudit('tools.hypothesis-engine.bases.uploaded', 'Hypothesis engine base uploaded', {
        userId,
        projectId: id,
        baseId: base.id,
        verticalId,
        rowCount: rows.length,
      });

      return NextResponse.json({ base }, { status: 201 });
    },
  );
}
