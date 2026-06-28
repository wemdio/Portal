import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { generateLeadSourceHypotheses } from '@/lib/projectBriefHypotheses/generateHypotheses';
import { SALES_HYPOTHESES_MODEL } from '@/lib/salesHypotheses/model';
import { RUN_DETAIL_COLUMNS, serializeRun } from '@/lib/salesHypotheses/run';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 200с / 150с: двухшаговая генерация (разбор ЦА + гипотезы) = 2 AI-вызова.
export const maxDuration = 200;

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const HYPOTHESES_TIMEOUT_MS = Number(process.env.PROJECT_HYPOTHESES_TIMEOUT_MS ?? '150000');

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// POST — сгенерировать гипотезы для прогона из сохранённого брифа.
// ?regenerate=1 — перегенерировать, иначе вернёт уже сохранённые (если есть).
// audience='internal' — сейлзу доступен полный каталог источников.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.sales-hypotheses.runs.generate' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { supabase, userId } = authed.auth;

      if (!OPENROUTER_BRIEF_API_KEY) {
        return jsonError('OPENROUTER_BRIEF_API_KEY не настроен на сервере', 500);
      }

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const regenerate = new URL(req.url).searchParams.get('regenerate') === '1';

      const { data: row, error: loadErr } = await supabase
        .from('sales_hypotheses_runs')
        .select(`${RUN_DETAIL_COLUMNS}, brief_text`)
        .eq('id', id)
        .single();
      if (loadErr) return jsonError(loadErr.message, loadErr.code === 'PGRST116' ? 404 : 500);

      const briefText = typeof row.brief_text === 'string' ? row.brief_text.trim() : '';
      if (!briefText) return jsonError('Бриф пуст — нечего скармливать AI.', 400);

      if (row.hypotheses && !regenerate) {
        return NextResponse.json({ run: serializeRun(row), skipped: true });
      }

      // Помечаем «генерируется», чтобы история показывала прогресс, если сейлз
      // откроет её в другой вкладке за время генерации (~90с).
      await supabase
        .from('sales_hypotheses_runs')
        .update({ status: 'generating', error_message: null })
        .eq('id', id)
        .eq('user_id', userId);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HYPOTHESES_TIMEOUT_MS);

      let hypotheses: string | null = null;
      let errorMessage: string | null = null;
      try {
        hypotheses = await generateLeadSourceHypotheses({
          apiKey: OPENROUTER_BRIEF_API_KEY,
          briefText,
          model: SALES_HYPOTHESES_MODEL,
          icpModel: SALES_HYPOTHESES_MODEL,
          signal: controller.signal,
          audience: 'internal',
        });
      } catch (err) {
        errorMessage = err instanceof Error
          ? err.name === 'AbortError'
            ? 'Превышен таймаут генерации гипотез (90с). Попробуйте ещё раз.'
            : err.message
          : 'Не удалось сгенерировать гипотезы';
        await logError('tools.sales-hypotheses.generate.failed', err, { userId: userId, runId: id });
      } finally {
        clearTimeout(timeoutId);
      }

      const { data: updated, error: updateErr } = await supabase
        .from('sales_hypotheses_runs')
        .update({
          // На транзиентной ошибке регенерации НЕ затираем прошлый успешный
          // результат: если новые гипотезы не сгенерились, но в строке уже были —
          // сохраняем старые и оставляем статус 'completed' (ошибку пишем в
          // error_message). Иначе первая же неудачная регенерация убивала готовый
          // результат и требовала прогон с нуля.
          hypotheses: hypotheses ?? row.hypotheses ?? null,
          hypotheses_generated_at: hypotheses
            ? new Date().toISOString()
            : (row.hypotheses_generated_at ?? null),
          hypotheses_model: hypotheses
            ? SALES_HYPOTHESES_MODEL
            : (row.hypotheses_model ?? null),
          status: hypotheses ? 'completed' : (row.hypotheses ? 'completed' : 'failed'),
          error_message: errorMessage,
        })
        .eq('id', id)
        .eq('user_id', userId)
        .select(RUN_DETAIL_COLUMNS)
        .single();

      if (updateErr || !updated) {
        await logError('tools.sales-hypotheses.generate.persist_failed', updateErr, { userId: userId, runId: id });
        return jsonError(updateErr?.message ?? 'Не удалось сохранить гипотезы', 500);
      }

      if (errorMessage) {
        return NextResponse.json({ run: serializeRun(updated), error: errorMessage }, { status: 502 });
      }

      void logAudit('tools.sales-hypotheses.generate.success', 'Sales hypotheses generated', {
        userId: userId,
        runId: id,
        regenerate,
      });
      return NextResponse.json({ run: serializeRun(updated) });
    },
  );
}
