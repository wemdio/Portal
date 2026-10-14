import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
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
import type { HeAutopilotVerticalDetail } from '@/lib/hypothesisEngine/autopilotReconcile';
import type { HeBrandInputLeak } from '@/lib/hypothesisEngine/letterBrandGuard';
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
  HE_ENG_LAUNCH_INTENT_TABLE,
  heEngAutoLaunchEnabled,
  heEngIntentSendingWindow,
  readHeEngLaunchIntent,
  updateHeEngLaunchSchedule,
  writeHeEngLaunchIntent,
} from '@/lib/hypothesisEngine/engAutoLaunch';
import { HE_ENG_MARKETS_MAX_PER_SAVE, heEngMarketPending } from '@/lib/hypothesisEngine/engMarkets';
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
/** «Launch N more markets»: рынки тела не те, что выбраны у проекта сейчас. */
const MARKETS_CHANGED_TEXT = 'The markets you chose have changed — refresh the page and try again.';
/** «Launch N more markets» без включённого автозапуска проекта. */
const MORE_NOT_LAUNCHED_TEXT = 'Press «Launch» first — it turns on automatic launch for your project.';
/**
 * То же при выключенном HE_ENG_AUTO_LAUNCH: «Launch» автозапуск сейчас не
 * включит, но начнёт эти рынки (реконсилер берёт все выбранные).
 */
const MORE_NOT_LAUNCHED_SWITCH_OFF_TEXT = 'Press «Launch» to start these markets.';
const INVALID_MARKETS_TEXT = `markets must be a list of 1 to ${HE_ENG_MARKETS_MAX_PER_SAVE} different market ids`;

/**
 * Стадии, чья джоба несёт vertical_id без базы: по ним «рынок уже
 * трогали» (heEngMarketPending). Джобы баз и шаблонов ссылаются на базу, а
 * база рынка сама делает его не «нетронутым».
 */
const VERTICAL_JOB_STAGES = ['chain', 'dossier', 'vocab'];

/** id рынков из тела «Launch N more markets»; null — тело не то. */
function parseMarketIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > HE_ENG_MARKETS_MAX_PER_SAVE) return null;
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !isValidUuid(value) || ids.includes(value)) return null;
    ids.push(value);
  }
  return ids;
}

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

/**
 * Рынки, которым это нажатие НЕ поставило письма, потому что поле брифа
 * называет наш бренд (причина реконсилера 'brand_input'), и сами поля —
 * кабинет называет их клиенту (EngStepLaunch, launchResultText). Поля — то,
 * что клиент сам вписал на шаге 1 (имя поля и слово), ничего сверх.
 */
function brandInputStops(details: HeAutopilotVerticalDetail[]): { markets: number; inputs: HeBrandInputLeak[] } {
  const stopped = details.filter((d) => d.reason === 'brand_input');
  return { markets: stopped.length, inputs: stopped.find((d) => (d.brandInputs ?? []).length > 0)?.brandInputs ?? [] };
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
// мастером — без withToolTrace. Миграции 20261012_0001 нет или выключатель
// HE_ENG_AUTO_LAUNCH выключен (тик воркера ничего не берёт) — available:false
// (кабинет тогда показывает «Launch now» у каждого готового рынка и не обещает
// старт «сам» и письмо о нём).
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
    available: intentRead.kind === 'ok' && heEngAutoLaunchEnabled(),
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
//     показывает с «Launch now» (тот же гейт отправки). Выключатель
//     HE_ENG_AUTO_LAUNCH выключен — ответ тоже auto_launch:'unavailable'
//     (готовый рынок сам не стартует, письма о старте не будет), а намерение
//     пишется ВЫКЛЮЧЕННЫМ (writeHeEngLaunchIntent autoLaunch:false: wanted
//     false без cancelled_at, часы и время нажатия сохранены — их берёт
//     «Launch now»): включат выключатель — тик это нажатие не возьмёт, нужен
//     новый «Launch». Сбой записи — 500 до постановки.
//  5. reconcileHeAutopilotProject(trigger 'client') — тот же путь и те же
//     правила оплаты, что у «Start outreach»: письма, сборка, анализ, финальные
//     письма; повтор упавшего — решение клиента, сборка, которая остановится
//     так же, не покупается (collect_again_verticals). Письма рынку, у которого
//     поле брифа называет наш бренд, не ставятся (причина 'brand_input'
//     реконсилера): ответ несёт их число и поля (brand_input_markets,
//     brand_inputs), кабинет называет поле шага 1.
// Запись намерения и постановка не атомарны: намерение — первым; упал
// реконсилер — 500, повторное нажатие доставит только недостающее.
//
// «LAUNCH N MORE MARKETS» — тело {markets: [vertical_id…]} без schedule
// (решение владельца 12.10.2026: рынок, отмеченный после «Launch», стартует
// только явным нажатием). Те же проверки 1–3 в том же порядке, дальше:
//  a. 1–50 разных uuid, каждый — вертикаль ЭТОГО проекта и выбран сейчас;
//     иначе 409 markets_changed;
//  b. автозапуск проекта включён (намерение wanted и autopilot=true); иначе
//     409 not_launched. Намерение НЕ переписывается (часы и время нажатия те
//     же), строки автозапуска других рынков ('failed', 'held') не трогаются —
//     это нажатие за другой рынок не платит. Снимается только отметка
//     «исполнено» (settled_at): исполненное намерение тик не читает, и
//     итоговые письма новых рынков сами бы не запустились;
//  c. по свежему чтению берутся только рынки, которые ещё ни разу не
//     трогали (heEngMarketPending); остальные — markets_already_started;
//  d. реконсилер с onlyVerticalIds: те же правила оплаты и потолок, только по
//     этим рынкам. Двойной клик ничего не дублирует: дедуп активных джоб и
//     уникальный индекс активной цепочки вертикали.
//  Ответ auto_launch — 'on' только при включённом выключателе
//  HE_ENG_AUTO_LAUNCH; выключен — 'unavailable' (как у «Launch»), и вместо
//  снятия отметки «исполнено» намерение ВЫКЛЮЧАЕТСЯ (wanted=false без
//  cancelled_at, как «Launch» при выключенном выключателе): клиенту сказано
//  «not available», и включённый позже выключатель эти рынки сам не запустит.
//  Кнопки при выключенном выключателе кабинет не показывает (autoOn), это —
//  вкладка, открытая до выключения, и прямой вызов. Намерение выключено —
//  409 not_launched с текстом про «Launch» без обещания автозапуска.
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

    let body: { schedule?: unknown; markets?: unknown } = {};
    try {
      const text = await req.text();
      body = text.trim() ? ((JSON.parse(text) ?? {}) as typeof body) : {};
    } catch {
      return jsonError('Invalid body', 400);
    }
    // «Launch N more markets»: часов в теле нет — у намерения они уже свои.
    let moreMarkets: string[] | null = null;
    if (body?.markets !== undefined) {
      if (body.schedule !== undefined && body.schedule !== null) {
        return jsonError('Send markets or schedule, not both', 400);
      }
      moreMarkets = parseMarketIds(body.markets);
      if (!moreMarkets) return jsonError(INVALID_MARKETS_TEXT, 400);
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
    if (!moreMarkets) {
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

    if (moreMarkets) {
      return launchMoreMarkets(supabaseAdmin, {
        userId,
        projectId: id,
        project: owned.project,
        markets: moreMarkets,
        sendingAccess: sending.state,
      });
    }

    // Автозапуск сработает, только если намерение записано И тик воркера
    // вообще берёт строки (выключатель HE_ENG_AUTO_LAUNCH): иначе ответ
    // 'unavailable', и кабинет ведёт к «Launch now», а не обещает старт сам.
    // При выключенном выключателе намерение пишется ВЫКЛЮЧЕННЫМ (часы и время
    // нажатия сохранены): клиенту сказано «not available», и включённый через
    // недели выключатель не запустит рынки без его нового «Launch».
    const autoLaunchSwitchOn = heEngAutoLaunchEnabled();
    const intent = await writeHeEngLaunchIntent(supabaseAdmin, {
      projectId: id,
      userId,
      schedule: sendingWindow,
      autoLaunch: autoLaunchSwitchOn,
    });
    if (intent === 'error') {
      return engServerError('client.eng.project_launch.intent_failed', new Error('launch intent not written'), LAUNCH_FAILED, {
        userId,
        projectId: id,
      });
    }
    const autoLaunch: 'on' | 'unavailable' = intent === 'ok' && autoLaunchSwitchOn ? 'on' : 'unavailable';

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
    const brand = brandInputStops(reconciled.details);

    void logAudit('client.eng.project_launch.requested', 'ENG client pressed Launch for the project', {
      userId,
      projectId: id,
      autoLaunch,
      // Выключатель выключен — намерение записано выключенным (тик его не возьмёт).
      ...(autoLaunchSwitchOn ? {} : { autoLaunchSwitch: 'off', ...(intent === 'ok' ? { intentWanted: false } : {}) }),
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
      ...(brand.markets > 0 ? { brandInputMarkets: brand.markets } : {}),
    });

    return NextResponse.json({
      ok: true,
      auto_launch: autoLaunch,
      sending_access: sendingAccessWord(sending.state),
      schedule: toClientEngSendingWindow(sendingWindow),
      chains_enqueued: reconciled.counts.chainsEnqueued,
      collects_enqueued: reconciled.counts.collectsEnqueued,
      templates_enqueued: reconciled.counts.templatesEnqueued,
      analyses_requeued: reconciled.counts.analysesRequeued,
      verticals_skipped: reconciled.counts.verticalsSkipped,
      collect_again_verticals: collectStopRepeats.length,
      autopilot_hold_code: hold?.code ?? null,
      brand_input_markets: brand.markets,
      brand_inputs: brand.inputs,
    });
  });
}

/** «Launch N more markets» после общих проверок POST (шапка POST, пункты a–d). */
async function launchMoreMarkets(
  db: SupabaseClient,
  args: {
    userId: string;
    projectId: string;
    project: Record<string, unknown>;
    markets: string[];
    sendingAccess: HeEngSendingAccessState;
  },
): Promise<NextResponse> {
  const { userId, projectId, markets } = args;
  const logContext = { userId, projectId };

  // a. Рынки — этого проекта и выбраны сейчас (тот же предикат выбора, что у
  // реконсилера: accepted-гипотеза с непустым id).
  const [verticalsRes, selectedRes] = await Promise.all([
    db.from('he_verticals').select('id').eq('project_id', projectId).in('id', markets),
    db.from('he_hypotheses').select('id, vertical_id').eq('project_id', projectId).eq('status', 'accepted').in('vertical_id', markets),
  ]);
  if (verticalsRes.error || selectedRes.error) {
    return engServerError(
      'client.eng.project_launch.more_markets_read_failed',
      verticalsRes.error ?? selectedRes.error,
      LAUNCH_FAILED,
      logContext,
    );
  }
  const own = new Set(((verticalsRes.data ?? []) as Array<{ id?: unknown }>).map((v) => String(v.id ?? '')));
  const selected = new Set(
    ((selectedRes.data ?? []) as Array<{ id?: unknown; vertical_id?: unknown }>)
      .filter((h) => typeof h.id === 'string' && h.id !== '')
      .map((h) => String(h.vertical_id ?? '')),
  );
  if (markets.some((m) => !own.has(m) || !selected.has(m))) {
    return NextResponse.json({ error: MARKETS_CHANGED_TEXT, code: 'markets_changed' }, { status: 409 });
  }

  // b. Автозапуск проекта включён: намерение wanted и автопилот (тик ведёт
  // только такие проекты). Нет таблицы намерения — автозапуска нет, и
  // начинать рынки этой кнопкой незачем: «Launch» берёт их все.
  const intentRead = await readHeEngLaunchIntent(db, projectId);
  if (intentRead.kind === 'error') {
    return engServerError('client.eng.project_launch.intent_read_failed', new Error(intentRead.message), LAUNCH_FAILED, logContext);
  }
  const intent = intentRead.kind === 'ok' ? intentRead.intent : null;
  // Намерение включено, но тик берёт строки только при включённом выключателе
  // HE_ENG_AUTO_LAUNCH — иначе новые рынки сами не стартуют (ответ
  // 'unavailable', а намерение ниже выключается вместо снятия «исполнено»).
  const autoLaunchSwitchOn = heEngAutoLaunchEnabled();
  const autoLaunch: 'on' | 'unavailable' = autoLaunchSwitchOn ? 'on' : 'unavailable';
  const notLaunched = () =>
    NextResponse.json(
      { error: autoLaunchSwitchOn ? MORE_NOT_LAUNCHED_TEXT : MORE_NOT_LAUNCHED_SWITCH_OFF_TEXT, code: 'not_launched' },
      { status: 409 },
    );
  if (!intent || !intent.wanted || args.project.autopilot !== true) return notLaunched();

  // c. Свежее чтение: рынок, который уже трогали (цепочка, база, шаблон или
  // джоба в любом статусе), этой кнопкой не начинается.
  const [chainsRes, basesRes, templatesRes, jobsRes] = await Promise.all([
    db.from('he_chains').select('id, vertical_id, status').in('vertical_id', markets),
    db.from('he_bases').select('id, vertical_id, status').eq('project_id', projectId).in('vertical_id', markets),
    db.from('he_templates').select('id, vertical_id').in('vertical_id', markets),
    db.from('he_jobs').select('id, status, payload').eq('project_id', projectId).in('stage', VERTICAL_JOB_STAGES),
  ]);
  const readErr = chainsRes.error ?? basesRes.error ?? templatesRes.error ?? jobsRes.error;
  if (readErr) {
    return engServerError('client.eng.project_launch.more_markets_read_failed', readErr, LAUNCH_FAILED, logContext);
  }
  const state = {
    chains: chainsRes.data ?? [],
    bases: basesRes.data ?? [],
    templates: templatesRes.data ?? [],
    jobs: jobsRes.data ?? [],
  };
  const pending = markets.filter((m) => heEngMarketPending(m, state));
  const alreadyStarted = markets.filter((m) => !pending.includes(m));
  const schedule = toClientEngSendingWindow(heEngIntentSendingWindow(intent));
  const answer = (extra: {
    started: string[];
    already: string[];
    counts?: { chainsEnqueued: number; collectsEnqueued: number; templatesEnqueued: number; analysesRequeued: number; verticalsSkipped: number };
    holdCode?: string | null;
    brand?: { markets: number; inputs: HeBrandInputLeak[] };
  }) =>
    NextResponse.json({
      ok: true,
      auto_launch: autoLaunch,
      sending_access: sendingAccessWord(args.sendingAccess),
      schedule,
      chains_enqueued: extra.counts?.chainsEnqueued ?? 0,
      collects_enqueued: extra.counts?.collectsEnqueued ?? 0,
      templates_enqueued: extra.counts?.templatesEnqueued ?? 0,
      analyses_requeued: extra.counts?.analysesRequeued ?? 0,
      verticals_skipped: extra.counts?.verticalsSkipped ?? 0,
      collect_again_verticals: 0,
      autopilot_hold_code: extra.holdCode ?? null,
      markets_started: extra.started,
      markets_already_started: extra.already,
      brand_input_markets: extra.brand?.markets ?? 0,
      brand_inputs: extra.brand?.inputs ?? [],
    });
  if (pending.length === 0) {
    void logAudit('client.eng.project_launch.more_markets', 'ENG client pressed Launch more markets; all had started', {
      ...logContext,
      markets,
      alreadyStarted,
    });
    return answer({ started: [], already: alreadyStarted });
  }

  // Исполненное намерение тик не читает (settled_at): снять отметку, иначе
  // итоговые письма новых рынков сами не запустились бы. Только у ещё
  // включённого намерения; отмена между чтением и записью — 0 строк.
  // Выключатель HE_ENG_AUTO_LAUNCH выключен — намерение выключается (wanted
  // false без cancelled_at, как у «Launch» при выключенном выключателе):
  // ответ скажет «not available — press «Launch now»», и тик после включения
  // выключателя ни эти, ни прежние рынки проекта сам не запустит.
  const nowIso = new Date().toISOString();
  const { data: reopened, error: reopenErr } = await db
    .from(HE_ENG_LAUNCH_INTENT_TABLE)
    .update(
      autoLaunchSwitchOn
        ? { settled_at: null, updated_at: nowIso }
        : { wanted: false, cancelled_at: null, settled_at: null, updated_at: nowIso },
    )
    .eq('project_id', projectId)
    .eq('wanted', true)
    .select('project_id');
  if (reopenErr) {
    return engServerError('client.eng.project_launch.reopen_failed', reopenErr, LAUNCH_FAILED, logContext);
  }
  if ((reopened ?? []).length === 0) return notLaunched();

  // d. Только эти рынки.
  const reconciled = await reconcileHeAutopilotProject(db, {
    projectId,
    project: args.project,
    trigger: 'client',
    onlyVerticalIds: pending,
  });
  if (!reconciled.ok && reconciled.kind === 'refused') {
    return reconciled.refusal === 'not_researched'
      ? NextResponse.json({ error: NOT_RESEARCHED_TEXT, code: 'not_researched' }, { status: 409 })
      : NextResponse.json({ error: MARKETS_CHANGED_TEXT, code: 'markets_changed' }, { status: 409 });
  }
  if (!reconciled.ok) {
    return engServerError(FAILURE_EVENT[reconciled.step] ?? 'client.eng.project_launch.failed', reconciled.error, LAUNCH_FAILED, {
      ...logContext,
      ...(reconciled.verticalId ? { verticalId: reconciled.verticalId } : {}),
      ...(reconciled.baseId ? { baseId: reconciled.baseId } : {}),
    });
  }
  // Начат — этим нажатием поставлена его цепочка писем. Цепочку между
  // чтением и вставкой поставил кто-то другой (уникальный индекс, 23505 →
  // 'chain_running') — рынок уже начат. Прочие пропуски (автопилот выключили,
  // потолок расхода, рынок сняли) — ни то ни другое: о них говорит пауза.
  const started = reconciled.details.filter((d) => d.outcome === 'chain_enqueued').map((d) => d.verticalId);
  const raced = reconciled.details.filter((d) => d.reason === 'chain_running').map((d) => d.verticalId);
  const hold = reconciled.pause ? toClientEngAutopilotHold({ autopilot_error: reconciled.pause }) : null;
  // Рынки, которым письма не поставлены из-за поля брифа, остаются
  // нетронутыми: та же кнопка начнёт их после правки поля.
  const brand = brandInputStops(reconciled.details);

  void logAudit('client.eng.project_launch.more_markets', 'ENG client pressed Launch more markets', {
    ...logContext,
    markets,
    started,
    alreadyStarted: [...alreadyStarted, ...raced],
    autoLaunch,
    // Выключатель выключен — намерение проекта этим нажатием выключено (выше).
    ...(autoLaunchSwitchOn ? {} : { autoLaunchSwitch: 'off', intentTurnedOff: true }),
    sendingAccess: args.sendingAccess,
    chainsEnqueued: reconciled.counts.chainsEnqueued,
    verticalsSkipped: reconciled.counts.verticalsSkipped,
    ...(reconciled.pause ? { autopilotPause: reconciled.pause } : {}),
    ...(brand.markets > 0 ? { brandInputMarkets: brand.markets } : {}),
  });

  return answer({
    started,
    already: [...alreadyStarted, ...raced],
    counts: reconciled.counts,
    holdCode: hold?.code ?? null,
    brand,
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
