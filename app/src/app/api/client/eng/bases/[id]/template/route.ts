import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeBase,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import { heTemplateGenerationBudget } from '@/lib/hypothesisEngine/autopilotNext';
import {
  HE_JOB_CLIENT_COLUMNS,
  toClientEngJobRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { HE_SPEND_PAUSED_EN } from '@/lib/hypothesisEngine/clientErrors';
import { enforceHeSpendCeiling, heSpendStopIsGlobal } from '@/lib/hypothesisEngine/spendCeiling';
import { engSpendLimitRefusal } from '@/lib/hypothesisEngine/engPaidAccess';
import { engSendingSwitchRefusal } from '@/lib/hypothesisEngine/engSendingSwitchGuard';
import { heBrandInputRefusalEn, heBrandInputsBeforeEnqueue } from '@/lib/hypothesisEngine/letterBrandGuard';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const TEMPLATE_START_FAILED = 'Failed to start the template';
const REFILL_BASE =
  'This audience is a nightly top-up of an audience that is already launched, so it has no template of its own.';
const TEMPLATE_EXISTS = 'This audience already has a template.';
const TEMPLATE_RACE_FINISHED =
  'Another request for this template has just finished. Refresh the page to see its result.';
const LETTERS_EXHAUSTED =
  'The letters for this audience were already generated the maximum number of times for its current ' +
  'analysis, so they are not generated again. Contact Support if you need new letters for it.';

/**
 * Активная (pending/running) template-джоба базы в клиентской проекции колонок —
 * дедуп до вставки и ответ на 23505 после неё.
 */
async function findActiveTemplateJob(projectId: string, baseId: string) {
  if (!supabaseAdmin) return { error: new Error('Server misconfigured') };
  const { data: active, error } = await supabaseAdmin
    .from('he_jobs')
    .select(HE_JOB_CLIENT_COLUMNS)
    .eq('project_id', projectId)
    .eq('stage', 'template')
    .in('status', ['pending', 'running']);
  if (error) return { error };
  const job = (active ?? []).find((j) => (j.payload as { base_id?: string } | null)?.base_id === baseId);
  return { job: job ?? null };
}

// POST — поставить генерацию шаблона 85/15 по СВОЕЙ проанализированной базе.
// База должна пройти анализ (status='analyzed'), иначе 409. Дедуп как у
// staff: активная template-задача на эту базу уже есть → 200 с ней же. Гонку
// двух кликов держит partial unique index he_jobs_one_active_template_per_base
// (20261008_0001_he_active_job_unique.sql): проигравшая вставка получает 23505
// и отвечает тем же 200 с уже стоящей джобой. Если индекс ещё не применён,
// вторая из двух вставленных джоб всё равно не платит: воркер берёт их по
// очереди, а стадия с payload.reuse (его ставит этот роут) возвращает уже
// готовый шаблон базы (stages/template.ts, findReusableTemplate). force этот
// роут не ставит никогда — пересборка писем кабинета («Rewrite letters») идёт
// отдельным роутом templates/[id]/rewrite, без force и без reuse: ей нужны
// новые письма.
//
// Генерация ПЛАТНАЯ (LLM), а из кабинета этот роут сейчас никто не зовёт
// (buildEngTemplate без вызывающего — шаблоны ставит автопилот), то есть сюда
// приходят только прямые запросы и старые бандлы. Поэтому те же тормоза, что у
// автопилота (autopilotNext.ts, afterBaseAnalyzeDone), плюс один, которого у
// него нет, потому что он сам в это состояние не попадает:
//   - refill-база («auto-refill: …») статус 'analyzed' получает без анализа —
//     её строки уезжают доливом в уже запущенную кампанию, шаблона ей не
//     положено (тот же признак, что у autopilotNext.ts, repairOrphanAnalyzingBase);
//   - у базы уже есть шаблон (любого статуса, в том числе снятый
//     «Rewrite letters»): новая генерация по той же базе — второй платный
//     прогон ради того, что уже есть; перезапись писем — только
//     templates/[id]/rewrite со своими проверками (тот же отказ у автопилота —
//     итог 'skipped:template_ready');
//   - бюджет писем поколения анализа (heTemplateGenerationBudget): без него
//     скрипт ставил бы новую платную генерацию после каждой закончившейся;
//   - поле брифа, которое промпт писем берёт дословно, называет наш бренд
//     (letterBrandGuard.heBrandInputsBeforeEnqueue; язык — самой новой
//     цепочки рынка, как у стадии): 409 brand_input с полем шага 1 — стадия
//     откажет до первого вызова модели, ставить нечего.
// Затем выключатель отправки аккаунта (engSendingSwitchRefusal), как у
// «Launch» проекта, и гейт платных шагов (requireEngPaidAccess, 'letters'):
// почта и потолок расхода клиента — после этих отказов, до потолка проекта и
// постановки.
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
      .select('filename, vertical_id')
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

    const active = await findActiveTemplateJob(owned.base.project_id as string, id);
    if (active.error) {
      return engServerError('client.eng.template.active_lookup_failed', active.error, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }
    if (active.job) return NextResponse.json({ ok: true, job: toClientEngJobRow(active.job) });

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

    // Наш бренд в поле брифа — до гейтов и постановки (шапка роута).
    const { data: briefRow, error: briefErr } = await supabaseAdmin
      .from('he_projects')
      .select('website_url, brief, created_by')
      .eq('id', owned.base.project_id as string)
      .maybeSingle();
    let brandInputs: Awaited<ReturnType<typeof heBrandInputsBeforeEnqueue>>;
    try {
      if (briefErr) throw briefErr;
      const verticalId = String((baseMeta as { vertical_id?: unknown } | null)?.vertical_id ?? '');
      brandInputs = await heBrandInputsBeforeEnqueue(supabaseAdmin, {
        market: projectMarket(owned.project),
        project: (briefRow ?? {}) as { website_url?: unknown; brief?: unknown; created_by?: unknown },
        ...(verticalId ? { verticalId } : {}),
      });
    } catch (briefReadErr) {
      return engServerError('client.eng.template.brief_read_failed', briefReadErr, TEMPLATE_START_FAILED, {
        userId: result.auth.userId,
        baseId: id,
      });
    }
    if (brandInputs.length > 0) {
      return NextResponse.json(
        { error: heBrandInputRefusalEn(brandInputs, 'press «Launch» on step 3'), code: 'brand_input' },
        { status: 409 },
      );
    }

    const switchRefusal = await engSendingSwitchRefusal(
      supabaseAdmin,
      result.auth.userId,
      (owned.base.project_id as string) ?? null,
      'client.eng.template.sending_access_unread',
    );
    if (switchRefusal) return switchRefusal;

    const access = await requireEngPaidAccess(supabaseAdmin, result.auth.userId, { action: 'letters' });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

    // Потолок расхода us-проекта (lib/hypothesisEngine/spendCeiling.ts; ПО
    // УМОЛЧАНИЮ ВЫКЛЮЧЕН — тогда ни одного запроса). Достигнут — платный шаг не
    // ставим: пауза 'spend_ceiling' на проекте и алерт команде уже сделаны в
    // enforceHeSpendCeiling, клиент читает ту же фразу, что и карточка паузы.
    // Неизвестный расход — ставим как без потолка (fail-open).
    const spend = await enforceHeSpendCeiling(supabaseAdmin, {
      projectId: owned.base.project_id as string,
      market: owned.project.market ?? null,
      stage: 'template',
      path: 'client_button',
      baseId: id,
      warn: (msg) => void logWarn('client.eng.template.spend_unknown', msg, { userId: result.auth.userId, baseId: id }),
    });
    // Общий потолок ENG паузы на проекте не пишет (spendCeiling.ts) — фраза
    // карточки паузы («…continues when they resume it») была бы неправдой.
    if (!spend.allowed) {
      return heSpendStopIsGlobal(spend.check)
        ? engPaidAccessResponse(engSpendLimitRefusal('eng_day'))
        : jsonError(HE_SPEND_PAUSED_EN, 409);
    }

    // `.select()` без аргументов вернул бы строку he_jobs целиком, вместе с
    // tokens_used/cost_usd и сырым текстом error: обе ветки роута отдают
    // джобу клиенту, значит и читать они обязаны одинаково.
    // reuse: true — готовый шаблон базы, легший между проверкой и исполнением,
    // стадия вернёт, а не оплатит заново (stages/template.ts, findReusableTemplate).
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('he_jobs')
      .insert({
        project_id: owned.base.project_id as string,
        stage: 'template',
        status: 'pending',
        payload: { base_id: id, reuse: true },
      })
      .select(HE_JOB_CLIENT_COLUMNS)
      .single();
    // 23505 — параллельный запрос успел раньше: тот же ответ, что у дедупа выше.
    // Стоящей джобы уже нет — значит, она успела закончиться (готово, упала или
    // отменена), и честный ответ — посмотреть её итог, а не ставить ещё одну.
    if (jobErr?.code === '23505') {
      const raced = await findActiveTemplateJob(owned.base.project_id as string, id);
      if (raced.error) {
        return engServerError('client.eng.template.active_lookup_failed', raced.error, TEMPLATE_START_FAILED, {
          userId: result.auth.userId,
          baseId: id,
        });
      }
      if (raced.job) return NextResponse.json({ ok: true, job: toClientEngJobRow(raced.job) });
      return jsonError(TEMPLATE_RACE_FINISHED, 409);
    }
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
