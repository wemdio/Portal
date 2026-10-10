import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeVertical,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import { AUTOPILOT_BASE_LIMIT } from '@/lib/hypothesisEngine/autopilotNext';
import { enqueueHeBaseCollect } from '@/lib/hypothesisEngine/baseCollectEnqueue';
import { toClientEngBase } from '@/lib/hypothesisEngine/clientEngProjection';
import { HE_SPEND_PAUSED_EN } from '@/lib/hypothesisEngine/clientErrors';
import { enforceHeSpendCeiling } from '@/lib/hypothesisEngine/spendCeiling';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const COLLECT_START_FAILED = 'Failed to start the collection';
const COLLECT_NOT_RESEARCHED =
  'A collection starts only on a researched project. Step 1 shows the state of the research.';
const COLLECT_NOT_SELECTED =
  'This vertical is not selected, so it was not collected. Accept at least one of its hypotheses on step 2 first.';
const COLLECT_HAS_BASE =
  'This vertical already has a collected base, so a new collection was not started. Step 4 shows that base.';

// POST — «Collect again» шага 4: новая авто-сборка базы СВОЕЙ вертикали.
// Единственный клиентский вызов — кнопка у последней базы вертикали,
// остановившейся решением, которое повторится (HE_COLLECT_STOP_REPEATS_CODES):
// «Start outreach» такую вертикаль больше не собирает (autopilotReconcile.ts),
// и повтор — только это явное нажатие. Сам роут повтор после любой остановки
// разрешает: нажатие и есть решение клиента заплатить ещё раз.
//
// Возможности, которыми кабинет не пользуется, закрыты (каждая — платная):
//  - лимит — только AUTOPILOT_BASE_LIMIT (2 000 строк сборки), тот же, что у
//    «Start outreach»; прежний выбор 10 000 кабинет не предлагал никогда;
//  - hypothesis_ids из тела не принимаются: сборка идёт по гипотезам,
//    принятым на шаге 2, ровно как у «Start outreach»;
//  - проект не 'researched', вертикаль не выбрана (нет accepted-гипотезы) или
//    у неё уже есть своя (не доливная) база в 'analyzing'/'analyzed' — 409:
//    вторая платная база поверх готовой — не то, что предлагает кнопка.
// Тело опционально: {limit?: 2000}. Дедуп и вставки — общие со staff
// (enqueueHeBaseCollect): уже идущая сборка → 200 + existing, иначе 201.
//
// ГЕЙТ ПЛАТНЫХ ШАГОВ (requireEngPaidAccess, 'collect'): почта и потолок
// расхода клиента — после отказов по состоянию, до потолка проекта и
// постановки.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.collect.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    // Тело опционально (пустое/не-JSON — ок). Лимит, если прислан, обязан
    // совпасть с лимитом кабинета; выбор гипотез из тела не принимается.
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    if (body && typeof body === 'object' && 'limit' in body) {
      const raw = (body as { limit?: unknown }).limit;
      if (raw !== undefined && raw !== AUTOPILOT_BASE_LIMIT) {
        return jsonError(`limit must be ${AUTOPILOT_BASE_LIMIT}`, 400);
      }
    }
    if (body && typeof body === 'object' && 'hypothesis_ids' in body) {
      return jsonError('hypothesis_ids is not accepted — a collection uses the hypotheses accepted on step 2', 400);
    }

    const owned = await loadClientHeVertical(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    if (owned.project.status !== 'researched') return jsonError(COLLECT_NOT_RESEARCHED, 409);

    // Состояние вертикали — тем же предикатом, что у «Start outreach»
    // (autopilotReconcile.ts): выбранность — accepted-гипотеза с непустым id;
    // своя база — source 'auto' без доливного «auto-refill: …».
    const [hypothesesRes, basesRes] = await Promise.all([
      supabaseAdmin
        .from('he_hypotheses')
        .select('id')
        .eq('vertical_id', id)
        .eq('status', 'accepted')
        .limit(500),
      supabaseAdmin
        .from('he_bases')
        .select('id, status, source, filename')
        .eq('vertical_id', id)
        .in('status', ['analyzing', 'analyzed'])
        .limit(500),
    ]);
    if (hypothesesRes.error || basesRes.error) {
      return engServerError(
        'client.eng.collect.state_read_failed',
        hypothesesRes.error ?? basesRes.error,
        COLLECT_START_FAILED,
        { userId: result.auth.userId, verticalId: id },
      );
    }
    const accepted = (hypothesesRes.data ?? [])
      .map((h) => (h as { id?: unknown }).id)
      .filter((hid): hid is string => typeof hid === 'string' && hid.length > 0);
    if (accepted.length === 0) return jsonError(COLLECT_NOT_SELECTED, 409);
    const hasOwnBase = (basesRes.data ?? []).some((b) => {
      const row = b as { source?: unknown; filename?: unknown };
      return row.source === 'auto' && !String(row.filename ?? '').startsWith('auto-refill');
    });
    if (hasOwnBase) return jsonError(COLLECT_HAS_BASE, 409);

    const access = await requireEngPaidAccess(supabaseAdmin, result.auth.userId, { action: 'collect' });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

    // Потолок расхода us-проекта (lib/hypothesisEngine/spendCeiling.ts; ПО
    // УМОЛЧАНИЮ ВЫКЛЮЧЕН — тогда ни одного запроса). Достигнут — платный шаг не
    // ставим: пауза 'spend_ceiling' на проекте и алерт команде уже сделаны в
    // enforceHeSpendCeiling, клиент читает ту же фразу, что и карточка паузы.
    // Неизвестный расход — ставим как без потолка (fail-open).
    // Проверка стоит ДО enqueueHeBaseCollect, а его дедуп («сборка уже идёт»)
    // — внутри: на проекте на паузе кнопка отвечает паузой и тогда, когда
    // прежняя сборка ещё идёт (она доработает — потолок её не обрывает).
    const spend = await enforceHeSpendCeiling(supabaseAdmin, {
      projectId: owned.vertical.project_id as string,
      market: owned.project.market ?? null,
      stage: 'base_collect',
      path: 'client_button',
      verticalId: id,
      warn: (msg) => void logWarn('client.eng.collect.spend_unknown', msg, { userId: result.auth.userId, verticalId: id }),
    });
    if (!spend.allowed) return jsonError(HE_SPEND_PAUSED_EN, 409);

    const collect = await enqueueHeBaseCollect(supabaseAdmin, {
      verticalId: id,
      projectId: owned.vertical.project_id as string,
      verticalName: owned.vertical.name as string,
      limit: AUTOPILOT_BASE_LIMIT,
      hypothesisIds: accepted,
    });
    if (!collect.ok) {
      return engServerError(
        'client.eng.collect.enqueue_failed',
        new Error(collect.message),
        COLLECT_START_FAILED,
        { userId: result.auth.userId, verticalId: id },
      );
    }
    // Дедуп-ветки enqueueHeBaseCollect выбирают `id, status, collect_info`, и
    // у идущей сборки в collect_info уже лежит план стадии: срезы каталога
    // (`plan.tasks[].pdl_filters`), поисковые запросы, `tasks[].child_job_id`,
    // `construct.bc_job_id`, русский текст `refill_result.error`. Проецируем
    // тем же toClientEngBase, что и деталка, — состав ответов про одну и ту же
    // базу обязан совпадать.
    if (!collect.created) {
      return NextResponse.json({ ok: true, existing: true, base: toClientEngBase(collect.base) });
    }

    void logAudit('client.eng.collect.enqueued', 'ENG cabinet auto-collect enqueued', {
      userId: result.auth.userId,
      verticalId: id,
      baseId: collect.base.id,
    });

    return NextResponse.json({ ok: true, base: toClientEngBase(collect.base) }, { status: 201 });
  });
}
