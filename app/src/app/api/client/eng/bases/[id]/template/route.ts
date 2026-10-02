import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeBase, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { heTemplateGenerationBudget } from '@/lib/hypothesisEngine/autopilotNext';
import {
  HE_JOB_CLIENT_COLUMNS,
  toClientEngJobRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const TEMPLATE_START_FAILED = 'Failed to start the template';
const REFILL_BASE =
  'This audience is a nightly top-up of an audience that is already launched, so it has no template of its own.';
const TEMPLATE_EXISTS = 'This audience already has a template.';
const LETTERS_EXHAUSTED =
  'The letters for this audience were already generated the maximum number of times for its current ' +
  'analysis. Ask your manager to look at it.';

// POST — поставить генерацию шаблона 85/15 по СВОЕЙ проанализированной базе.
// База должна пройти анализ (status='analyzed'), иначе 409. Дедуп как у
// staff: активная template-задача на эту базу уже есть → 200 с ней же.
//
// Генерация ПЛАТНАЯ (LLM), а из кабинета этот роут сейчас никто не зовёт
// (buildEngTemplate без вызывающего — шаблоны ставит автопилот), то есть сюда
// приходят только прямые запросы и старые бандлы. Поэтому те же тормоза, что у
// автопилота (autopilotNext.ts, afterBaseAnalyzeDone), плюс два, которых у
// него нет, потому что он сам в эти состояния не попадает:
//   - refill-база («auto-refill: …») статус 'analyzed' получает без анализа —
//     её строки уезжают доливом в уже запущенную кампанию, шаблона ей не
//     положено (тот же признак, что у autopilotNext.ts, repairOrphanAnalyzingBase);
//   - у базы уже есть шаблон: новая генерация по той же базе — второй платный
//     прогон ради того, что уже есть; пересборку писем кабинет не предлагает;
//   - бюджет писем поколения анализа (heTemplateGenerationBudget): без него
//     скрипт ставил бы новую платную генерацию после каждой закончившейся.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.template.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeBase(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    if ((owned.base as { status?: string }).status !== 'analyzed') {
      return jsonError('The base is not analyzed yet — wait for the analysis to finish', 409);
    }

    const { data: baseMeta, error: baseMetaErr } = await supabaseAdmin
      .from('he_bases')
      .select('filename')
      .eq('id', id)
      .maybeSingle();
    if (baseMetaErr) {
      return engServerError('client.eng.template.base_read_failed', baseMetaErr, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }
    if (String((baseMeta as { filename?: unknown } | null)?.filename ?? '').startsWith('auto-refill')) {
      return jsonError(REFILL_BASE, 409);
    }

    const { data: active, error: activeErr } = await supabaseAdmin
      .from('he_jobs')
      .select(HE_JOB_CLIENT_COLUMNS)
      .eq('project_id', owned.base.project_id as string)
      .eq('stage', 'template')
      .in('status', ['pending', 'running']);
    if (activeErr) {
      return engServerError('client.eng.template.active_lookup_failed', activeErr, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }
    const existing = (active ?? []).find(
      (j) => (j.payload as { base_id?: string } | null)?.base_id === id,
    );
    if (existing) return NextResponse.json({ ok: true, job: toClientEngJobRow(existing) });

    const { data: templates, error: templatesErr } = await supabaseAdmin
      .from('he_templates')
      .select('id')
      .eq('base_id', id)
      .limit(1);
    if (templatesErr) {
      return engServerError('client.eng.template.existing_lookup_failed', templatesErr, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }
    if ((templates ?? []).length > 0) return jsonError(TEMPLATE_EXISTS, 409);

    // Сбой чтения бюджета — отказ, а не «потрачено ноль»: функция бросает
    // HeAutopilotReadError ровно для того, чтобы её не приняли за разрешение.
    let budgetAllowed: boolean;
    try {
      budgetAllowed = (
        await heTemplateGenerationBudget(supabaseAdmin, {
          projectId: owned.base.project_id as string,
          baseId: id,
        })
      ).allowed;
    } catch (budgetErr) {
      return engServerError('client.eng.template.budget_read_failed', budgetErr, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }
    if (!budgetAllowed) return jsonError(LETTERS_EXHAUSTED, 409);

    // `.select()` без аргументов вернул бы строку he_jobs целиком, вместе с
    // tokens_used/cost_usd и сырым текстом error: обе ветки роута отдают
    // джобу клиенту, значит и читать они обязаны одинаково.
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('he_jobs')
      .insert({
        project_id: owned.base.project_id as string,
        stage: 'template',
        status: 'pending',
        payload: { base_id: id },
      })
      .select(HE_JOB_CLIENT_COLUMNS)
      .single();
    if (jobErr || !job) {
      return engServerError('client.eng.template.enqueue_failed', jobErr, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }

    void logAudit('client.eng.template.enqueued', 'ENG cabinet template enqueued', {
      userId: result.auth.userId,
      baseId: id,
      jobId: job.id,
    });

    return NextResponse.json({ ok: true, job: toClientEngJobRow(job) }, { status: 201 });
  });
}
