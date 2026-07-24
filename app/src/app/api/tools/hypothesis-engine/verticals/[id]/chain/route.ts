import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { HeChainLanguage } from '@/lib/hypothesisEngine/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const LANGUAGES: HeChainLanguage[] = ['ru', 'en', 'pl'];

// POST — поставить генерацию цепочки писем для вертикали.
// Дедуп: активная (pending/running) chain-задача на эту вертикаль уже есть →
// возвращаем её со статусом 200, новую не создаём.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.chain.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let language: HeChainLanguage = 'ru';
      try {
        const body = (await req.json()) as { language?: unknown };
        if (body?.language !== undefined) {
          if (typeof body.language !== 'string' || !LANGUAGES.includes(body.language as HeChainLanguage)) {
            return jsonError('language должен быть ru, en или pl', 400);
          }
          language = body.language as HeChainLanguage;
        }
      } catch {
        // Пустое/битое тело = язык по умолчанию.
      }

      const { data: vertical, error: vertErr } = await supabaseAdmin
        .from('he_verticals')
        .select('id, project_id')
        .eq('id', id)
        .single();
      if (vertErr) {
        return jsonError(
          vertErr.code === 'PGRST116' ? 'Вертикаль не найдена' : vertErr.message,
          vertErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const { data: active, error: activeErr } = await supabaseAdmin
        .from('he_jobs')
        .select('*')
        .eq('project_id', vertical.project_id)
        .eq('stage', 'chain')
        .in('status', ['pending', 'running']);
      if (activeErr) return jsonError(activeErr.message, 500);
      const existing = (active ?? []).find(
        (j) => (j.payload as { vertical_id?: string } | null)?.vertical_id === id,
      );
      if (existing) return NextResponse.json({ ok: true, job: existing });

      const { data: job, error: jobErr } = await supabaseAdmin
        .from('he_jobs')
        .insert({
          project_id: vertical.project_id,
          stage: 'chain',
          status: 'pending',
          payload: { vertical_id: id, language },
        })
        .select()
        .single();
      if (jobErr || !job) {
        await logError('tools.hypothesis-engine.chain.enqueue_failed', jobErr, { userId, verticalId: id });
        return jsonError(jobErr?.message ?? 'Не удалось поставить задачу', 500);
      }

      void logAudit('tools.hypothesis-engine.chain.enqueued', 'Hypothesis engine chain enqueued', {
        userId,
        verticalId: id,
        language,
        jobId: job.id,
      });

      return NextResponse.json({ ok: true, job }, { status: 201 });
    },
  );
}
