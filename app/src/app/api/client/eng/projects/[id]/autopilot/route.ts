import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeProject,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import { reconcileHeAutopilotProject } from '@/lib/hypothesisEngine/autopilotReconcile';
import type {
  HeAutopilotReconcileStep,
  HeAutopilotRefusal,
} from '@/lib/hypothesisEngine/autopilotReconcile';
import { toClientEngAutopilotHold } from '@/lib/hypothesisEngine/clientEngProjection';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

/** Один текст на все сбои роута: наружу — он, подробности — в application_logs. */
const OUTREACH_START_FAILED = 'Failed to start the outreach';

/** Отказ по состоянию проекта — 409 с английским текстом кабинета. */
const REFUSAL_TEXT: Record<HeAutopilotRefusal, string> = {
  not_researched: 'The research is not finished yet — the autopilot starts once the project is researched',
  no_verticals: 'No markets yet — wait for the research to produce them',
};

/**
 * Шаг общего пути → код события лога. Коды прежние: по ним ищут в
 * application_logs, и переименование стоило бы истории поиска.
 */
const FAILURE_EVENT: Record<HeAutopilotReconcileStep, string> = {
  verticals: 'client.eng.autopilot.verticals_failed',
  snapshot: 'client.eng.autopilot.snapshot_failed',
  flag: 'client.eng.autopilot.flag_failed',
  chain_enqueue: 'client.eng.autopilot.chain_enqueue_failed',
  collect_enqueue: 'client.eng.autopilot.collect_enqueue_failed',
  template_budget: 'client.eng.autopilot.template_budget_failed',
  template_enqueue: 'client.eng.autopilot.template_enqueue_failed',
};

// POST — «Start outreach»: включает автопилот проекта (he_projects.autopilot=true)
// и идемпотентно доставляет недостающие стадии конвейера по каждой
// КЛИЕНТ-ВЫБРАННОЙ вертикали. Сама логика доставки — в общем модуле
// lib/hypothesisEngine/autopilotReconcile: ровно тот же код каждую ночь
// выполняет автоматический проход крона (trigger='nightly'), и второй
// реализации у кабинета нет.
//
// ВЫКЛЮЧАТЕЛЬ у автопилота один — отмена проекта (POST .../cancel, кнопка
// «Cancel all jobs»): она пишет autopilot=false и ставит на паузу ночной добор.
// Отдельного DELETE здесь нет намеренно: автопилот без отмены уже стоящих
// стадий выключил бы только постановку СЛЕДУЮЩИХ, а идущие продолжили бы
// платить — кнопки с таким смыслом в кабинете нет. Повторное нажатие
// «Start outreach» после отмены включает автопилот снова, но паузу ночного
// добора НЕ снимает: её возвращает сотрудник (staff-инструмент).
//
// Отличие ручного вызова от ночного (см. докблок модуля): человек вправе
// оплатить повтор упавшей стадии, машина — нет. Исключение и для человека —
// сборка вертикали, чья последняя база остановилась решением, которое новая
// сборка повторит (HE_COLLECT_STOP_REPEATS_CODES): её «Start outreach» не
// покупает, повтор — явная «Collect again» (POST .../verticals/[id]/collect);
// такие вертикали считает collect_again_verticals ответа. Тормоз бесконечной
// генерации писем (бюджет поколения анализа) действует в обоих режимах.
//
// ГЕЙТ ПЛАТНЫХ ШАГОВ (requireEngPaidAccess, действие 'start_outreach'):
// подтверждённая почта и потолок расхода клиента — ДО реконсилера, потому что
// каждое его действие (цепочка, сборка, ремонт анализа, письма) платное.
// Отказ — типизированный 4xx с английским текстом и кодом (engPaidAccess.ts).
// Потолки проекта и клиента реконсилер проверяет и сам (createHeSpendGate).
//
// Границы: проект обязан быть status='researched' (verticals/гипотезы уже есть)
// и иметь хотя бы одну вертикаль — иначе 409. Рынок НЕ ограничиваем: флаг и
// постановка доступны любому СВОЕМУ проекту (staff-кабинет тоже может захотеть),
// язык chain всё равно вычисляется из market.
//
// verticals_skipped в ответе — вертикали, по которым в этом вызове ничего не
// потребовалось ставить (всё уже в работе, готово или ждёт человека).
// Вылеченная осиротевшая база пропуском НЕ считается: ей поставлен
// base_analyze, и в ответе это отдельный счётчик analyses_requeued.
// autopilot_hold_code — пауза, записанная этим же вызовом (null — паузы нет):
// без неё «ничего не поставлено» неотличимо от «всё уже готово».
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.autopilot.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const access = await requireEngPaidAccess(supabaseAdmin, result.auth.userId, { action: 'start_outreach' });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

    const reconciled = await reconcileHeAutopilotProject(supabaseAdmin, {
      projectId: id,
      project: owned.project,
      trigger: 'client',
    });

    if (!reconciled.ok && reconciled.kind === 'refused') {
      return jsonError(REFUSAL_TEXT[reconciled.refusal], 409);
    }
    if (!reconciled.ok) {
      return engServerError(FAILURE_EVENT[reconciled.step], reconciled.error, OUTREACH_START_FAILED, {
        userId: result.auth.userId,
        projectId: id,
        ...(reconciled.verticalId ? { verticalId: reconciled.verticalId } : {}),
        ...(reconciled.baseId ? { baseId: reconciled.baseId } : {}),
      });
    }

    // Ремонт осиротевшей базы мог не удаться: запуск от этого успешен (сборку
    // по такой вертикали не запускаем — строки уже оплачены), но причина
    // обязана быть в application_logs, а не только в счётчике пропусков.
    for (const detail of reconciled.details) {
      if (!detail.message) continue;
      void logError(
        'client.eng.autopilot.orphan_repair_failed',
        new Error(detail.message),
        { userId: result.auth.userId, projectId: id, verticalId: detail.verticalId },
      );
    }

    // Числа, по которым тормоз писем принял решение (сколько платных прогонов
    // уже записано на это поколение анализа и какое это поколение). Без них
    // специалист, открывший исчерпанный проект, не отличит честное третье
    // падение от бюджета, съеденного строкой, которую закрыл сторож простоя, —
    // и вынужден повторять запрос руками. В ответ КЛИЕНТУ они не идут: ему
    // едет код паузы, а не счётчик.
    const lettersBudget = reconciled.details.flatMap((detail) =>
      detail.letters ? [{ verticalId: detail.verticalId, ...detail.letters }] : [],
    );
    // Вертикали, которым это нажатие НЕ купило новую сборку, потому что их
    // последняя база остановилась решением, которое повторится: след в аудите
    // (вертикаль и код причины) и число для кабинета.
    const collectStopRepeats = reconciled.details.flatMap((detail) =>
      detail.reason === 'collect_stop_repeats'
        ? [{ verticalId: detail.verticalId, code: detail.stopCode ?? null }]
        : [],
    );

    void logAudit('client.eng.autopilot.enabled', 'ENG cabinet autopilot enabled', {
      userId: result.auth.userId,
      projectId: id,
      chainsEnqueued: reconciled.counts.chainsEnqueued,
      collectsEnqueued: reconciled.counts.collectsEnqueued,
      templatesEnqueued: reconciled.counts.templatesEnqueued,
      analysesRequeued: reconciled.counts.analysesRequeued,
      verticalsSkipped: reconciled.counts.verticalsSkipped,
      ...(reconciled.pause ? { autopilotPause: reconciled.pause } : {}),
      ...(lettersBudget.length > 0 ? { lettersBudget } : {}),
      ...(collectStopRepeats.length > 0 ? { collectStopRepeats } : {}),
    });

    // Пауза уезжает в ответ КОДОМ кабинета, а не причиной движка: словарь
    // движка закрытый, но он про его собственные решения, и переводит его в
    // язык клиента ровно одна карта (`toClientEngAutopilotHold`) — та же, по
    // которой паузу читает деталка проекта. Второй таблицы соответствия у
    // кабинета быть не должно, поэтому причина прогоняется через ту же функцию
    // строкой проекта, а не пересобирается здесь заново. Метки времени в ответе
    // нет: её показывает карточка мастера, читающая настоящую колонку.
    //
    // Зачем вообще: нажатие, не поставившее НИЧЕГО, до этого отчитывалось
    // «всё уже стоит или готово» — в том числе там, где ничего не стало
    // именно из-за паузы (письма исчерпаны, состояние не прочиталось, ремонт
    // осиротевшей базы не удался). Зелёный успех на заблокированном проекте —
    // ровно та ложь, из-за которой клиент ждёт вместо того, чтобы написать.
    const hold = reconciled.pause
      ? toClientEngAutopilotHold({ autopilot_error: reconciled.pause })
      : null;

    return NextResponse.json({
      ok: true,
      chains_enqueued: reconciled.counts.chainsEnqueued,
      collects_enqueued: reconciled.counts.collectsEnqueued,
      templates_enqueued: reconciled.counts.templatesEnqueued,
      analyses_requeued: reconciled.counts.analysesRequeued,
      verticals_skipped: reconciled.counts.verticalsSkipped,
      // Сколько из пропущенных — «повтор остановится так же»: кабинет говорит
      // о них отдельной фразой и ведёт к «Collect again» на шаге 4
      // (EngStepVerticals), иначе пропуск читался бы как «всё уже готово».
      collect_again_verticals: collectStopRepeats.length,
      autopilot_hold_code: hold?.code ?? null,
    });
  });
}
