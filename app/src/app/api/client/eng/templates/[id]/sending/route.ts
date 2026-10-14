/**
 * Отправка кампаний запуска шаблона (вертикали) в английском кабинете.
 *
 * GET  — сводка: настоящий статус кампаний у рассыльщика и счётчики
 *        (engCampaignStatus: кэш на все процессы, живое чтение фоном не чаще
 *        раза в 5 минут на кампанию, только API кампаний, не LIST /emails) и
 *        кнопка, которую карточка рисует ('pause' | 'start' | 'resume' | null),
 *        и вторая рядом с Pause (`secondary_action: 'start_rest'` — часть
 *        кампаний стоит; нажатие — тот же POST { action: 'start' }).
 *        `sending: null` — шаблон не запущен.
 * POST { action: 'start' }  — «Start sending» / «Resume»: старт кампаний запуска
 *        (engCampaignSending.startHeEngLaunchSending — те же проверки, что у
 *        старта при запуске: гейт писем, выключатель аккаунта (и перед каждым
 *        стартом кампании), ящики пула проекта (ни один не в пресете другого
 *        клиента и не в живом запуске RU-кабинета), адреса и воркспейс живой
 *        кампании, статус; плюс отказ запуску до self-serve отправки
 *        проекта — 409 'pre_self_serve'). Перед ним — гейт
 *        платных шагов действием 'launch' (подтверждённая почта; потолок расхода,
 *        по умолчанию выключен): старт отправляет письма живым людям так же, как
 *        запуск.
 * POST { action: 'pause' }  — «Pause»: желание клиента записывается до
 *        рассыльщика (его читают доводка паузы при чтении статуса и проверка
 *        ночного долива createHeRefillSendGate в autoPipeline.ts), затем пауза
 *        каждой кампании. Не спрашивает ни выключатель, ни почту, ни лимит
 *        частоты: остановить отправку можно всегда.
 *
 * Скоуп: только свой шаблон (loadClientHeTemplate: шаблон → вертикаль → проект
 * created_by = клиент), только ENG (requireEngMarket), демо — только чтение
 * (requireClientAuth режет мутации). Частота — только у СТАРТА: 'sending_action'
 * (engRateLimit, 30 нажатий «Start sending» / «Resume» в час на пользователя);
 * отказ старта попадание возвращает. Повтор безопасен: старт отправляющей
 * кампании и пауза стоящей ничего не меняют.
 *
 * client_instantly_access этот роут не пишет (см. шапку engCampaignSending.ts).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeTemplate,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import { parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
import {
  pauseHeEngLaunchSending,
  readHeEngSendingSummaries,
  startHeEngLaunchSending,
} from '@/lib/hypothesisEngine/engCampaignSending';
import type { HeEngSendingSummary } from '@/lib/hypothesisEngine/engCampaignStatus';
import { heEngRetryMinutes, hitHeEngRateLimit, releaseHeEngRateHit } from '@/lib/hypothesisEngine/engRateLimit';
import { logWarn } from '@/lib/loggerServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Сколько роут тратит на вызовы рассыльщика (кампании сверх — «not_attempted»). */
const ACTION_BUDGET_MS = 45_000;

const LOAD_FAILED = 'Failed to load the sending status';

/** Отказ лимита — только у старта (Pause лимита нет). */
function tooManyText(minutes: number): string {
  return (
    'You have started sending many times within the last hour, so sending was not started this time. ' +
    `Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. Pause always works.`
  );
}

/** Запись о запуске шаблона (свежая, из БД). */
async function readLaunch(db: SupabaseClient, templateId: string) {
  const { data, error } = await db.from('he_templates').select('launch_info').eq('id', templateId).maybeSingle();
  if (error) return { error } as const;
  return { launch: parseLaunchInfo((data as { launch_info?: unknown } | null)?.launch_info ?? null) } as const;
}

async function summaryOf(
  userId: string,
  projectId: string,
  templateId: string,
  refresh: boolean,
): Promise<HeEngSendingSummary | null | { error: unknown }> {
  if (!supabaseAdmin) return null;
  const read = await readLaunch(supabaseAdmin, templateId);
  if ('error' in read) return { error: read.error };
  if (!read.launch) return null;
  const map = await readHeEngSendingSummaries(supabaseAdmin, supabaseInstantly, {
    userId,
    launches: [{ projectId, templateId, launch: read.launch }],
    refresh,
  });
  return map.get(templateId) ?? null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const gate = await requireEngMarket(supabaseAdmin, userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  const { id } = await params;
  if (!isValidUuid(id)) return jsonError('Invalid id', 400);
  const owned = await loadClientHeTemplate(supabaseAdmin, id, userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const summary = await summaryOf(userId, String(owned.project.id), id, true);
  if (summary && 'error' in summary) {
    return engServerError('client.eng.template.sending.load_failed', summary.error, LOAD_FAILED, { userId, templateId: id });
  }
  return NextResponse.json({ sending: summary });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.sending.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);
    const portalDb = supabaseAdmin;
    const instantlyDb = supabaseInstantly;

    const { userId } = result.auth;
    const gate = await requireEngMarket(portalDb, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);
    let body: { action?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid body', 400);
    }
    const action = body?.action;
    if (action !== 'start' && action !== 'pause') return jsonError('Provide action: start or pause', 400);

    const owned = await loadClientHeTemplate(portalDb, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);
    const projectId = String(owned.project.id);

    // Лимит частоты — только у старта: пауза не отказывается никогда (ни
    // лимитом, ни гейтом платных шагов).
    let hit: Awaited<ReturnType<typeof hitHeEngRateLimit>> | null = null;
    if (action === 'start') {
      const access = await requireEngPaidAccess(portalDb, userId, { action: 'launch' });
      if (!access.ok) return engPaidAccessResponse(access.refusal);

      hit = await hitHeEngRateLimit(portalDb, 'sending_action', userId);
      if (hit.fallbackReason) {
        void logWarn('client.eng.sending.limit_fallback', `sending-action count decided in process memory: ${hit.fallbackReason}`, {
          userId,
        });
      }
      if (!hit.allowed) {
        return NextResponse.json(
          { error: tooManyText(heEngRetryMinutes(hit.retryAfterSeconds)), retry_after_seconds: hit.retryAfterSeconds },
          { status: 429, headers: { 'Retry-After': String(hit.retryAfterSeconds) } },
        );
      }
    }

    const deadlineMs = Date.now() + ACTION_BUDGET_MS;
    const outcome =
      action === 'start'
        ? await startHeEngLaunchSending({
            portalDb,
            instantlyDb,
            clientUserId: userId,
            projectId,
            templateId: id,
            via: 'start',
            deadlineMs,
          })
        : await pauseHeEngLaunchSending({
            portalDb,
            instantlyDb,
            ownerUserId: userId,
            projectId,
            templateId: id,
            by: 'client',
            deadlineMs,
          });

    if (outcome.kind === 'refused') {
      // Отказ старта нажатием не считается (у паузы попадания нет).
      if (hit) await releaseHeEngRateHit(portalDb, 'sending_action', userId, hit);
      return NextResponse.json({ error: outcome.message, code: outcome.code }, { status: outcome.status });
    }

    const summary = await summaryOf(userId, projectId, id, false);
    const sending = summary && !('error' in summary) ? summary : null;
    if (outcome.kind === 'done' && 'started' in outcome) {
      return NextResponse.json({
        action,
        result: {
          campaigns: outcome.campaigns,
          started: outcome.started,
          already_sending: outcome.alreadySending,
          completed: outcome.completed,
          failed: outcome.failed.map((f) => f.code),
          not_attempted: outcome.notAttempted,
          unconfirmed: outcome.unconfirmed,
          compensated: outcome.compensated,
          compensation_failed: outcome.compensationFailed,
        },
        sending,
      });
    }
    return NextResponse.json({
      action,
      result: {
        campaigns: outcome.campaigns,
        paused: outcome.paused,
        failed: outcome.failed.length,
        not_attempted: outcome.notAttempted,
        // Pause клиента не записался (he_eng_launch_sending) — кабинет говорит,
        // что пауза может не удержаться (команде ушёл алерт 'pause_failed').
        state_recorded: outcome.stateRecorded,
      },
      sending,
    });
  });
}
