import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeProject,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import { switchHeUsRefill } from '@/lib/hypothesisEngine/autoPipeline';
import { toClientEngRefillState } from '@/lib/hypothesisEngine/clientEngProjection';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

// Тексты уезжают клиенту как есть (английские константы роута, кабинет
// пропускает их сквозь engErrorText). Действие названо тем же словом, что
// переключатель дашборда, — «daily top-up».
const TOP_UP_NOT_AVAILABLE = 'The daily top-up is not available for this project.';
const TOP_UP_NO_LAUNCH =
  'The daily top-up starts after the first launch: launch a template on step 5 «Review & Launch» first.';
const TOP_UP_SETUP_PROBLEM =
  'The daily top-up cannot be switched right now because of a problem on our side. Message Support.';
const TOP_UP_FAILED = 'Failed to switch the daily top-up';

// POST { enabled: boolean } — переключатель «Daily top-up» проекта на дашборде
// (S2, решение владельца 10–11.10.2026: ночной добор настраивается сам после
// первого запуска, включает и выключает его клиент). Что делают «on» и «off» и
// чего они НЕ делают — блок «ПЕРЕКЛЮЧАТЕЛЬ КЛИЕНТА» в
// lib/hypothesisEngine/autoPipeline.ts (switchHeUsRefill):
//  - «off» — enabled=false; ночь проект не обходит, а долив уже купленной ночи
//    перед отправкой видит выключатель и контакты не добавляет;
//  - «on» — enabled=true (нет конфига, а запуск есть — заводит его) и снимает
//    только паузу, поставленную самим клиентом кнопкой «Cancel all jobs».
//    Паузы ёмкости рассыльщика и потолка расхода остаются командными.
//
// Границы: рынок (requireEngMarket), владелец (loadClientHeProject — чужой
// проект отвечает 404) и us-проект. «on» снова делает проект кандидатом
// НОЧНОЙ платной сборки, поэтому у него гейт платных шагов
// (requireEngPaidAccess, 'resume_refill': почта и потолок расхода клиента), а
// «off» — нет: остановить добор можно всегда. Ночь сама проверяет потолки,
// ёмкость и то, берут ли кампании контакты (autoPipeline.ts).
//
// Ответ — { ok, outcome, refill }: исход переключения (HeUsRefillSwitchOutcome)
// и состояние добора проекта после него (HeClientRefillState, та же проекция,
// что у дашборда). Тексты итога пишет кабинет (EngDashboard).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.project_refill.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const { userId } = result.auth;

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    let body: { enabled?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid body', 400);
    }
    if (typeof body?.enabled !== 'boolean') return jsonError('Provide enabled: true or false', 400);
    const enabled = body.enabled;

    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);
    if (projectMarket(owned.project as { market?: string | null }) !== 'us') {
      return jsonError(TOP_UP_NOT_AVAILABLE, 403);
    }

    if (enabled) {
      const access = await requireEngPaidAccess(supabaseAdmin, userId, { action: 'resume_refill' });
      if (!access.ok) return engPaidAccessResponse(access.refusal);
    }

    const switched = await switchHeUsRefill(supabaseAdmin, id, enabled);
    switch (switched.outcome) {
      case 'no_launch':
        return NextResponse.json({ error: TOP_UP_NO_LAUNCH, code: 'no_launch' }, { status: 409 });
      case 'not_us':
        return jsonError(TOP_UP_NOT_AVAILABLE, 403);
      case 'unsupported':
        // Таблицы конфига нет — чинит выкатка, а не повтор. Код свой, не
        // 'unavailable': тем словом кабинет узнаёт отказ гейта платных шагов.
        void logWarn('client.eng.project_refill.unsupported', 'he_auto_pipeline_configs is missing', {
          userId,
          projectId: id,
          detail: switched.detail ?? null,
        });
        return NextResponse.json({ error: TOP_UP_SETUP_PROBLEM, code: 'top_up_unavailable' }, { status: 503 });
      case 'failed':
        return engServerError(
          'client.eng.project_refill.failed',
          new Error(switched.detail ?? 'daily top-up switch failed'),
          TOP_UP_FAILED,
          { userId, projectId: id, enabled },
        );
      default:
        break;
    }

    void logAudit('client.eng.project_refill.switched', `ENG daily top-up ${enabled ? 'on' : 'off'}: ${switched.outcome}`, {
      userId,
      projectId: id,
      outcome: switched.outcome,
    });
    return NextResponse.json({
      ok: true,
      outcome: switched.outcome,
      refill: toClientEngRefillState(switched.config as Record<string, unknown> | null),
    });
  });
}
