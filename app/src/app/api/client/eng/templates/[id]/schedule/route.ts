/**
 * Окно отправки запущенного шаблона английского кабинета: посмотреть и
 * поменять.
 *
 * GET  — что предложить клиенту: окно, которое СЕЙЧАС стоит у кампаний
 *        запуска (или, до запуска, дефолт), список поясов и дней, которые
 *        рассыльщик принимает, и флаг «шаблон уже запущен». Работает и до
 *        запуска: тем же ответом кабинет заполняет форму на шаге «Review &
 *        Launch». Кабинет печатает `schedule ?? default` как текущее окно
 *        (EngStepReview.tsx), поэтому у запущенного шаблона `schedule` обязан
 *        быть правдой: сохранённый выбор клиента — только если он новее записи о
 *        запуске, иначе окно основной кампании, прочитанное у рассыльщика.
 * PATCH — переставить окно у кампаний, которые создал ЭТОТ запуск. Второй
 *        обязательный сценарий владельца: клиент выбрал окно при запуске и
 *        может передумать после.
 *
 * Почему отдельный роут, а не поле в PATCH кампании (`api/client/campaigns/[id]`):
 * кабинет ENG не знает про кампании рассыльщика вовсе — их id это внутренние
 * идентификаторы, наружу они не отдаются (`clientEngProjection`), а запуск
 * одного шаблона создаёт их несколько (сплит по сегментам базы). Клиент думает
 * о шаблоне, поэтому и адресуется шаблоном.
 *
 * Границы ответа — как во всём контуре: 4xx это английские константы-причины,
 * 5xx идут через `engServerError` (константа + машинный код, сырьё в
 * `application_logs`), наружу не уходит ни текст рассыльщика, ни id кампаний.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeTemplate, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
import { resolveInstantlyAccountId, type InstantlyRequestOptions } from '@/lib/instantly/accounts';
import type { ClientLaunchScheduleOverride } from '@/lib/clientLaunch/types';
import { resolveClientInstantlyRequestOptions } from '@/lib/instantly/clientAccountOptions';
import { logAudit, logError, logWarn } from '@/lib/loggerServer';
import { engServerError } from '../../../_shared';
import {
  ENG_SENDING_WINDOW_TIMEZONES,
  ENG_SENDING_WINDOW_TIMEZONES_DROPPED,
  ENG_SENDING_WINDOW_WEEKDAYS,
  applyEngSendingWindow,
  engDefaultSendingWindow,
  loadEngSendingWindow,
  parseEngSendingWindow,
  readEngCampaignSendingWindow,
  saveEngSendingWindow,
  toClientEngSendingWindow,
} from '../../../_launchWindow';

export const dynamic = 'force-dynamic';

const LOAD_FAILED = 'Failed to load the sending window';
const UPDATE_FAILED = 'Failed to update the sending window';
const NOT_LAUNCHED =
  'This template has not been launched yet — pick the sending window when you launch it.';
/** Окно у рассыльщика переставлено, а запись выбора в кабинете не сохранилась. */
const WARNING_NOT_SAVED =
  'Your new sending window is live on the campaigns but was not saved in the cabinet, ' +
  'so this screen may show the previous window next time.';

/** Один раз на процесс: опечатка в списке поясов молча отняла бы пункт. */
let droppedTimezonesLogged = false;

async function noteDroppedTimezones(userId: string): Promise<void> {
  if (droppedTimezonesLogged || ENG_SENDING_WINDOW_TIMEZONES_DROPPED.length === 0) return;
  droppedTimezonesLogged = true;
  await logWarn(
    'client.eng.template.schedule.timezone_dropped',
    'ENG sending-window timezone option is not accepted by the sending service',
    { dropped: [...ENG_SENDING_WINDOW_TIMEZONES_DROPPED] },
    { userId },
  );
}

/**
 * Кампании запуска. Скалярное поле — основная кампания (запуски до сплита),
 * `campaigns[]` — все, включая сегментные: окно выбрано на шаблон, ставим всем.
 * `primaryId` и `createdAt` нужны GET: чьё окно читать у рассыльщика и с чем
 * сравнивать свежесть сохранённого выбора.
 */
function launchCampaignIds(
  launchInfo: unknown,
): { ids: string[]; presetId: string; primaryId: string; createdAt: string } | null {
  const launch = parseLaunchInfo(launchInfo);
  if (!launch) return null;
  const ids = (launch.campaigns?.map((c) => c.campaign_id) ?? [launch.campaign_id]).filter(
    (cid): cid is string => typeof cid === 'string' && cid.length > 0,
  );
  if (ids.length === 0) return null;
  return { ids, presetId: launch.preset_id, primaryId: launch.campaign_id, createdAt: launch.created_at };
}

/**
 * Сохранённый выбор описывает ЭТОТ запуск, только если записан после него.
 * Запуск клиента пишет выбор после записи о запуске (роут launch), правка окна
 * — тем более; а запуск сотрудника из RU-инструмента, force-перезапуск и
 * достройка, чей PATCH окна не дошёл, переписывают запись о запуске, не трогая
 * выбор, — тогда выбор старше и про прошлые кампании. Непарсящееся время —
 * «не знаем», то есть не свежий.
 */
function savedAfterLaunch(savedAt: string | null, launchCreatedAt: string): boolean {
  const saved = savedAt ? Date.parse(savedAt) : Number.NaN;
  const launched = launchCreatedAt ? Date.parse(launchCreatedAt) : Number.NaN;
  return Number.isFinite(saved) && Number.isFinite(launched) && saved >= launched;
}

/**
 * В какой аккаунт рассыльщика ходить: в тот же, в котором ядро создало
 * кампанию. Он задан пресетом запуска (его id лежит в записи о запуске), и
 * читаем пресет со скоупом владельца — чужой невидим. Промах аккаунтом означал
 * бы PATCH в чужой воркспейс. Пресета в записи нет (запуск до появления поля) —
 * общий клиентский резолвер.
 */
async function resolveLaunchRequestOptions(args: {
  instantlyDb: SupabaseClient;
  userId: string;
  templateId: string;
  presetId: string;
}): Promise<InstantlyRequestOptions | null> {
  const { instantlyDb, userId, templateId, presetId } = args;
  if (!presetId) return resolveClientInstantlyRequestOptions(userId);
  const { data: presetRow, error: presetErr } = await instantlyDb
    .from('client_campaign_presets')
    .select('instantly_account_id')
    .eq('id', presetId)
    .eq('client_user_id', userId)
    .maybeSingle();
  if (presetErr) {
    await logError('client.eng.template.schedule.preset_failed', presetErr, { userId, templateId });
    return null;
  }
  return {
    accountId: resolveInstantlyAccountId(
      (presetRow as { instantly_account_id?: string | null } | null)?.instantly_account_id ?? null,
    ),
  };
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

  const { data: templateRow, error: templateErr } = await supabaseAdmin
    .from('he_templates')
    .select('launch_info')
    .eq('id', id)
    .maybeSingle();
  if (templateErr) {
    return engServerError('client.eng.template.schedule.load_failed', templateErr, LOAD_FAILED, {
      userId,
      templateId: id,
    });
  }

  // Сохранённого окна может не быть (шаблон ещё не запускали, запуск до этой
  // волны или не из кабинета, миграция не применена) — это не ошибка.
  const stored = await loadEngSendingWindow(supabaseAdmin, id);
  if (!stored.ok) {
    await logError('client.eng.template.schedule.stored_read_failed', stored.error, {
      userId,
      templateId: id,
    });
  }
  await noteDroppedTimezones(userId);

  const launch = launchCampaignIds((templateRow as { launch_info?: unknown } | null)?.launch_info);
  let current: ClientLaunchScheduleOverride | null = stored.ok ? stored.window : null;
  if (launch && !(stored.ok && stored.window && savedAfterLaunch(stored.savedAt, launch.createdAt))) {
    // Шаблон запущен, а выбора клиента про ЭТОТ запуск нет: кампании стоят с
    // часами пресета (запуск сотрудника, запуск до этой волны), со старым
    // выбором (force поверх него) или с прежними часами (PATCH окна не дошёл).
    // Показать здесь дефолт или старый выбор значило бы выдать за текущее
    // окно то, по чему письма не пойдут, — читаем окно у рассыльщика. Не
    // прочиталось — честный отказ: «не знаем окна» лучше, чем чужие часы под
    // фразой «Emails go out only inside these hours».
    const requestOptions = supabaseInstantly
      ? await resolveLaunchRequestOptions({
          instantlyDb: supabaseInstantly,
          userId,
          templateId: id,
          presetId: launch.presetId,
        })
      : null;
    const live = requestOptions
      ? await readEngCampaignSendingWindow({ campaignId: launch.primaryId, requestOptions })
      : ({ ok: false, error: new Error('instantly db or preset account unavailable') } as const);
    if (!live.ok || !live.window) {
      return engServerError(
        'client.eng.template.schedule.live_read_failed',
        live.ok ? new Error('campaign sending window is not representable') : live.error,
        LOAD_FAILED,
        { userId, templateId: id },
      );
    }
    current = live.window;
  }

  return NextResponse.json({
    schedule: current ? toClientEngSendingWindow(current) : null,
    default: toClientEngSendingWindow(engDefaultSendingWindow()),
    timezones: ENG_SENDING_WINDOW_TIMEZONES.map((o) => ({ value: o.value, label: o.label })),
    weekdays: ENG_SENDING_WINDOW_WEEKDAYS.map((o) => ({ value: o.value, label: o.label })),
    launched: launch !== null,
  });
}

/**
 * PATCH — переставить окно у кампаний запуска.
 *
 * Идемпотентно: наружу уходит только `campaign_schedule`, собранное из выбора
 * клиента, поэтому повтор того же тела приводит кампании в то же состояние и
 * ничего больше в них не меняет (письма, ящики, лимиты, пауза не упоминаются).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.schedule.patch' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

    const { userId } = result.auth;
    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    let body: { schedule?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid body', 400);
    }
    // Здесь окно ОБЯЗАТЕЛЬНО: цель запроса — заменить его. Пустое тело означало
    // бы «поменяй на непонятно что», а не «оставь как было».
    const parsedWindow = parseEngSendingWindow(body?.schedule);
    if (!parsedWindow.ok) return jsonError(parsedWindow.error, 400);
    const sendingWindow = parsedWindow.window;

    const owned = await loadClientHeTemplate(supabaseAdmin, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const { data: templateRow, error: templateErr } = await supabaseAdmin
      .from('he_templates')
      .select('launch_info')
      .eq('id', id)
      .maybeSingle();
    if (templateErr) {
      return engServerError('client.eng.template.schedule.load_failed', templateErr, UPDATE_FAILED, {
        userId,
        templateId: id,
      });
    }

    const launch = launchCampaignIds((templateRow as { launch_info?: unknown } | null)?.launch_info);
    if (!launch) return jsonError(NOT_LAUNCHED, 409);

    const requestOptions = await resolveLaunchRequestOptions({
      instantlyDb: supabaseInstantly,
      userId,
      templateId: id,
      presetId: launch.presetId,
    });
    if (!requestOptions) {
      return engServerError(
        'client.eng.template.schedule.preset_unresolved',
        new Error('preset account unresolved'),
        UPDATE_FAILED,
        { userId, templateId: id },
      );
    }

    const applied = await applyEngSendingWindow({
      campaignIds: launch.ids,
      window: sendingWindow,
      requestOptions,
    });

    // Ни одна кампания не приняла окно — это отказ: менять было нечего, и
    // клиент должен увидеть ошибку, а не «сохранено».
    if (applied.updated === 0) {
      return engServerError(
        'client.eng.template.schedule.apply_failed',
        applied.lastError ?? new Error('no campaign updated'),
        UPDATE_FAILED,
        { userId, templateId: id, campaigns: launch.ids.length },
      );
    }

    const warnings: string[] = [];
    if (applied.failed > 0) {
      // Часть кампаний осталась на прежнем окне. Отказом не отвечаем: часть уже
      // переставлена, повтор безопасен (см. идемпотентность выше).
      await logError('client.eng.template.schedule.apply_partial', applied.lastError, {
        userId,
        templateId: id,
        campaigns: launch.ids.length,
        failed: applied.failed,
      });
      warnings.push(
        'Part of this launch kept the previous sending window. Save the window again — ' +
          'campaigns that already use the new one are not affected.',
      );
    }

    const saved = await saveEngSendingWindow(supabaseAdmin, {
      templateId: id,
      clientUserId: userId,
      window: sendingWindow,
    });
    if (!saved.ok) {
      await logError('client.eng.template.schedule.save_failed', saved.error, {
        userId,
        templateId: id,
      });
      warnings.push(WARNING_NOT_SAVED);
    }

    await logAudit(
      'client.eng.template.schedule.updated',
      'ENG client changed the sending window of a launched template',
      {
        userId,
        templateId: id,
        timezone: sendingWindow.timezone,
        from: sendingWindow.from,
        to: sendingWindow.to,
        days: sendingWindow.days,
        campaigns: applied.updated,
      },
    );

    // Наружу — выбор клиента и СКОЛЬКО кампаний его приняли. Именно счётчик, а
    // не идентификаторы: id кампаний рассыльщика в кабинет не уезжают.
    return NextResponse.json({
      ok: true,
      schedule: toClientEngSendingWindow(sendingWindow),
      campaigns_updated: applied.updated,
      campaigns_total: launch.ids.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  });
}
