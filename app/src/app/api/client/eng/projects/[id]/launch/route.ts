import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError, logWarn } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeProject,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import { reconcileHeAutopilotProject } from '@/lib/hypothesisEngine/autopilotReconcile';
import { toClientEngAutopilotHold } from '@/lib/hypothesisEngine/clientEngProjection';
import {
  ENG_SENDING_ACCESS_PROBLEM_TEXT,
  ENG_SENDING_TURNED_OFF_TEXT,
  readHeEngSendingAccess,
  requireHeEngSendingAccess,
  type HeEngSendingAccessState,
} from '@/lib/hypothesisEngine/engSendingAccess';
import { ENG_PAID_UNAVAILABLE_TEXT } from '@/lib/hypothesisEngine/engPaidAccess';
import {
  heEngIntentSendingWindow,
  readHeEngLaunchIntent,
  updateHeEngLaunchSchedule,
  writeHeEngLaunchIntent,
} from '@/lib/hypothesisEngine/engAutoLaunch';
import { engServerError } from '../../../_shared';
import {
  ENG_SENDING_WINDOW_TIMEZONES,
  ENG_SENDING_WINDOW_WEEKDAYS,
  engDefaultSendingWindow,
  parseEngSendingWindow,
  toClientEngSendingWindow,
} from '../../../_launchWindow';

export const dynamic = 'force-dynamic';

/** Один текст на сбои роута: наружу — он, подробности — в application_logs. */
const LAUNCH_FAILED = 'Failed to launch';

const NOT_RESEARCHED_TEXT =
  'The research is not finished yet — your markets appear on step 2 when it is.';
const NO_MARKETS_TEXT = 'Pick at least one market on step 2 first.';
const NOT_LAUNCHED_TEXT = 'Press Launch first — the sending hours are saved with it.';

/**
 * Состояние выключателя отправки аккаунта — словом для кабинета (строка
 * доступа на шаге 3): 'not_enabled' — отправку включит команда один раз,
 * 'revoked' — выключена (Launch недоступен), 'unknown' — не прочиталось.
 * Сотрудник (not_client) и снятое требование — 'not_required'.
 */
type EngSendingAccessWord = 'enabled' | 'not_required' | 'not_enabled' | 'revoked' | 'unknown';

function sendingAccessWord(state: HeEngSendingAccessState): EngSendingAccessWord {
  switch (state) {
    case 'enabled':
      return 'enabled';
    case 'not_required':
    case 'not_client':
      return 'not_required';
    case 'not_enabled':
      return 'not_enabled';
    case 'revoked':
      return 'revoked';
    case 'unavailable':
    case 'error':
      return 'unknown';
  }
}

/** Шаг события лога по шагу сбоя общего пути (как у «Start outreach»). */
const FAILURE_EVENT: Record<string, string> = {
  verticals: 'client.eng.project_launch.verticals_failed',
  snapshot: 'client.eng.project_launch.snapshot_failed',
  flag: 'client.eng.project_launch.flag_failed',
  chain_enqueue: 'client.eng.project_launch.chain_enqueue_failed',
  collect_enqueue: 'client.eng.project_launch.collect_enqueue_failed',
  template_budget: 'client.eng.project_launch.template_budget_failed',
  template_enqueue: 'client.eng.project_launch.template_enqueue_failed',
};

// GET — что знает шаг 3 до и после «Launch»: включён ли автозапуск (намерение
// проекта), окно отправки будущих запусков, список зон и дней, дефолт и
// состояние выключателя отправки аккаунта (без записи и алерта). Поллится
// мастером — без withToolTrace. Миграции 20261012_0001 нет — available:false
// (кабинет тогда показывает «Launch now» у каждого готового рынка).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!isValidUuid(id)) return jsonError('Invalid id', 400);

  const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const [intentRead, access] = await Promise.all([
    readHeEngLaunchIntent(supabaseAdmin, id),
    readHeEngSendingAccess(supabaseAdmin, result.auth.userId),
  ]);
  if (intentRead.kind === 'error') {
    return engServerError('client.eng.project_launch.intent_read_failed', new Error(intentRead.message), LAUNCH_FAILED, {
      userId: result.auth.userId,
      projectId: id,
    });
  }
  const intent = intentRead.kind === 'ok' ? intentRead.intent : null;
  return NextResponse.json({
    available: intentRead.kind === 'ok',
    requested: intent?.wanted === true,
    requested_at: intent?.requestedAt || null,
    cancelled_at: intent?.cancelledAt ?? null,
    schedule: intent ? toClientEngSendingWindow(heEngIntentSendingWindow(intent)) : null,
    default: toClientEngSendingWindow(engDefaultSendingWindow()),
    timezones: ENG_SENDING_WINDOW_TIMEZONES.map((o) => ({ value: o.value, label: o.label })),
    weekdays: ENG_SENDING_WINDOW_WEEKDAYS.map((o) => ({ value: o.value, label: o.label })),
    sending_access: sendingAccessWord(access.state),
  });
}

// POST — «Launch» шага 3: ОДНА кнопка доводит проект до отправки.
//  1. Проверки: проект свой, 'researched', выбран хотя бы один рынок (есть
//     accepted-гипотеза — тот же предикат, что у реконсилера), окно отправки
//     верное.
//  2. Гейт платных шагов — действие 'start_outreach' (этот вызов ставит
//     платные стадии ровно как «Start outreach»).
//  3. Выключатель отправки аккаунта ЧИТАЕТСЯ: выключен сотрудником — 403, ничего
//     не поставлено (письма и сборка были бы оплачены зря); не прочитался —
//     503 (сбой чтения мог скрыть выключение) и нет его таблицы (миграция
//     20261011_0002: ни один старт не пройдёт) — 503 с алертом команде, в
//     обоих случаях ничего не записано и не поставлено; ещё не включён —
//     записываем, что клиент ждёт, и зовём команду (requireHeEngSendingAccess,
//     отказ здесь не возвращаем): подготовка идёт, а запуск вертикалей
//     подождёт включения (автозапуск держит их 'held').
//  4. Намерение (writeHeEngLaunchIntent: wanted, окно, время нажатия, отметка
//     «исполнено» снята; строки 'failed' и 'done cancelled' — снова в работу,
//     'held' — проверить сейчас). Нет таблицы намерения (миграция
//     20261012_0001 не применена; порядок выката — миграция до кода) — ответ
//     auto_launch:'unavailable', подготовка всё равно идёт: это та же оплата,
//     что у «Start outreach» без этой миграции, а готовые рынки шаг 3 тогда
//     показывает с «Launch now» (тот же гейт отправки). Сбой записи — 500 до
//     постановки.
//  5. reconcileHeAutopilotProject(trigger 'client') — тот же путь и те же
//     правила оплаты, что у «Start outreach»: письма, сборка, анализ, финальные
//     письма; повтор упавшего — решение клиента, сборка, которая остановится
//     так же, не покупается (collect_again_verticals).
// Запись намерения и постановка не атомарны: намерение — первым; упал
// реконсилер — 500, повторное нажатие доставит только недостающее.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.project_launch.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const userId = result.auth.userId;

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    let body: { schedule?: unknown } = {};
    try {
      const text = await req.text();
      body = text.trim() ? ((JSON.parse(text) ?? {}) as typeof body) : {};
    } catch {
      return jsonError('Invalid body', 400);
    }
    const parsedWindow =
      body?.schedule === undefined || body?.schedule === null
        ? ({ ok: true, window: engDefaultSendingWindow() } as const)
        : parseEngSendingWindow(body.schedule);
    if (!parsedWindow.ok) return jsonError(parsedWindow.error, 400);
    const sendingWindow = parsedWindow.window;

    if (owned.project.status !== 'researched') {
      return NextResponse.json({ error: NOT_RESEARCHED_TEXT, code: 'not_researched' }, { status: 409 });
    }
    const { data: selected, error: selectedErr } = await supabaseAdmin
      .from('he_hypotheses')
      .select('id')
      .eq('project_id', id)
      .eq('status', 'accepted')
      .limit(1);
    if (selectedErr) {
      return engServerError('client.eng.project_launch.selection_failed', selectedErr, LAUNCH_FAILED, { userId, projectId: id });
    }
    if ((selected ?? []).length === 0) {
      return NextResponse.json({ error: NO_MARKETS_TEXT, code: 'no_markets' }, { status: 409 });
    }

    const access = await requireEngPaidAccess(supabaseAdmin, userId, { action: 'start_outreach' });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

    const sending = await readHeEngSendingAccess(supabaseAdmin, userId);
    if (sending.state === 'revoked') {
      return NextResponse.json({ error: ENG_SENDING_TURNED_OFF_TEXT, code: 'sending_turned_off' }, { status: 403 });
    }
    if (sending.state === 'error') {
      // Сбой чтения мог скрыть выключение сотрудником — ничего не пишем и не
      // ставим (fail-closed), тот же ответ, что у гейта платных шагов.
      void logWarn('client.eng.project_launch.sending_access_unread', sending.detail ?? 'sending switch read failed', {
        userId,
        projectId: id,
      });
      return NextResponse.json({ error: ENG_PAID_UNAVAILABLE_TEXT, code: 'unavailable' }, { status: 503 });
    }
    if (sending.state === 'unavailable') {
      // Таблицы выключателя нет (миграция 20261011_0002): ни один старт ENG не
      // пройдёт, пока её не применят, — подготовку не оплачиваем. Гейт зовём
      // ради его алерта команде (access_unavailable); ответ — свой.
      await requireHeEngSendingAccess(supabaseAdmin, userId, { projectId: id, via: 'launch' });
      return NextResponse.json(
        { error: ENG_SENDING_ACCESS_PROBLEM_TEXT, code: 'sending_access_unavailable' },
        { status: 503 },
      );
    }
    if (sending.state === 'not_enabled') {
      // Отметка «клиент ждёт» и алерт команде (дедуп в процессе, 1 ч). Отказ
      // не возвращаем: подготовка идёт, запуск подождёт включения.
      await requireHeEngSendingAccess(supabaseAdmin, userId, { projectId: id, via: 'launch' });
    }

    const intent = await writeHeEngLaunchIntent(supabaseAdmin, { projectId: id, userId, schedule: sendingWindow });
    if (intent === 'error') {
      return engServerError('client.eng.project_launch.intent_failed', new Error('launch intent not written'), LAUNCH_FAILED, {
        userId,
        projectId: id,
      });
    }

    const reconciled = await reconcileHeAutopilotProject(supabaseAdmin, {
      projectId: id,
      project: owned.project,
      trigger: 'client',
    });
    if (!reconciled.ok && reconciled.kind === 'refused') {
      return reconciled.refusal === 'not_researched'
        ? NextResponse.json({ error: NOT_RESEARCHED_TEXT, code: 'not_researched' }, { status: 409 })
        : NextResponse.json({ error: NO_MARKETS_TEXT, code: 'no_markets' }, { status: 409 });
    }
    if (!reconciled.ok) {
      return engServerError(
        FAILURE_EVENT[reconciled.step] ?? 'client.eng.project_launch.failed',
        reconciled.error,
        LAUNCH_FAILED,
        {
          userId,
          projectId: id,
          ...(reconciled.verticalId ? { verticalId: reconciled.verticalId } : {}),
          ...(reconciled.baseId ? { baseId: reconciled.baseId } : {}),
        },
      );
    }
    for (const detail of reconciled.details) {
      if (!detail.message) continue;
      void logError('client.eng.project_launch.orphan_repair_failed', new Error(detail.message), {
        userId,
        projectId: id,
        verticalId: detail.verticalId,
      });
    }
    const collectStopRepeats = reconciled.details.filter((d) => d.reason === 'collect_stop_repeats');
    const hold = reconciled.pause ? toClientEngAutopilotHold({ autopilot_error: reconciled.pause }) : null;

    void logAudit('client.eng.project_launch.requested', 'ENG client pressed Launch for the project', {
      userId,
      projectId: id,
      autoLaunch: intent === 'ok' ? 'on' : 'unavailable',
      sendingAccess: sending.state,
      timezone: sendingWindow.timezone,
      from: sendingWindow.from,
      to: sendingWindow.to,
      days: sendingWindow.days,
      chainsEnqueued: reconciled.counts.chainsEnqueued,
      collectsEnqueued: reconciled.counts.collectsEnqueued,
      templatesEnqueued: reconciled.counts.templatesEnqueued,
      analysesRequeued: reconciled.counts.analysesRequeued,
      verticalsSkipped: reconciled.counts.verticalsSkipped,
      ...(reconciled.pause ? { autopilotPause: reconciled.pause } : {}),
    });

    return NextResponse.json({
      ok: true,
      auto_launch: intent === 'ok' ? 'on' : 'unavailable',
      sending_access: sendingAccessWord(sending.state),
      schedule: toClientEngSendingWindow(sendingWindow),
      chains_enqueued: reconciled.counts.chainsEnqueued,
      collects_enqueued: reconciled.counts.collectsEnqueued,
      templates_enqueued: reconciled.counts.templatesEnqueued,
      analyses_requeued: reconciled.counts.analysesRequeued,
      verticals_skipped: reconciled.counts.verticalsSkipped,
      collect_again_verticals: collectStopRepeats.length,
      autopilot_hold_code: hold?.code ?? null,
    });
  });
}

// PATCH — окно отправки будущих ПЕРВЫХ запусков рынков проекта (до или после
// «Launch»; рынок с записью о запуске держит своё окно, его часы меняет
// PATCH .../templates/[id]/schedule).
// Намерения нет — 409 not_launched: окно сохраняется вместе с «Launch».
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.project_launch.patch' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const userId = result.auth.userId;

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    let body: { schedule?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid body', 400);
    }
    const parsedWindow = parseEngSendingWindow(body?.schedule);
    if (!parsedWindow.ok) return jsonError(parsedWindow.error, 400);

    const owned = await loadClientHeProject(supabaseAdmin, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const saved = await updateHeEngLaunchSchedule(supabaseAdmin, {
      projectId: id,
      userId,
      schedule: parsedWindow.window,
    });
    if (saved === 'no_intent' || saved === 'missing') {
      return NextResponse.json({ error: NOT_LAUNCHED_TEXT, code: 'not_launched' }, { status: 409 });
    }
    if (saved === 'error') {
      return engServerError('client.eng.project_launch.schedule_failed', new Error('launch schedule not saved'), LAUNCH_FAILED, {
        userId,
        projectId: id,
      });
    }
    void logAudit('client.eng.project_launch.schedule_changed', 'ENG client changed the sending hours of future launches', {
      userId,
      projectId: id,
      timezone: parsedWindow.window.timezone,
      from: parsedWindow.window.from,
      to: parsedWindow.window.to,
      days: parsedWindow.window.days,
    });
    return NextResponse.json({ ok: true, schedule: toClientEngSendingWindow(parsedWindow.window) });
  });
}
