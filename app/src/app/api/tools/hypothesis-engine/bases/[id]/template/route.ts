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

// POST — поставить генерацию шаблона 85/15 по проанализированной базе.
// База должна пройти стадию base_analyze (status='analyzed'), иначе 409.
// Дедуп: активная (pending/running) template-задача на эту базу уже есть →
// возвращаем её со статусом 200, новую не создаём.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.template.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data: base, error: baseErr } = await supabaseAdmin
        .from('he_bases')
        .select('id, project_id, status')
        .eq('id', id)
        .single();
      if (baseErr) {
        return jsonError(
          baseErr.code === 'PGRST116' ? 'База не найдена' : baseErr.message,
          baseErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      if (base.status !== 'analyzed') {
        return jsonError('База ещё не проанализирована — дождитесь завершения анализа', 409);
      }

      const { data: active, error: activeErr } = await supabaseAdmin
        .from('he_jobs')
        .select('*')
        .eq('project_id', base.project_id)
        .eq('stage', 'template')
        .in('status', ['pending', 'running']);
      if (activeErr) return jsonError(activeErr.message, 500);
      const existing = (active ?? []).find(
        (j) => (j.payload as { base_id?: string } | null)?.base_id === id,
      );
      if (existing) return NextResponse.json({ ok: true, job: existing });

      const { data: job, error: jobErr } = await supabaseAdmin
        .from('he_jobs')
        .insert({
          project_id: base.project_id,
          stage: 'template',
          status: 'pending',
          payload: { base_id: id },
        })
        .select()
        .single();
      if (jobErr || !job) {
        await logError('tools.hypothesis-engine.template.enqueue_failed', jobErr, { userId, baseId: id });
        return jsonError(jobErr?.message ?? 'Не удалось поставить задачу', 500);
      }

      void logAudit('tools.hypothesis-engine.template.enqueued', 'Hypothesis engine template enqueued', {
        userId,
        baseId: id,
        jobId: job.id,
      });

      return NextResponse.json({ ok: true, job }, { status: 201 });
    },
  );
}

// GET — последний шаблон по базе (404, если генерации ещё не было).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.template.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data, error } = await supabaseAdmin
        .from('he_templates')
        .select('*')
        .eq('base_id', id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) return jsonError(error.message, 500);

      const template = (data ?? [])[0];
      if (!template) return jsonError('Шаблон ещё не сгенерирован', 404);
      return NextResponse.json({ template });
    },
  );
}
