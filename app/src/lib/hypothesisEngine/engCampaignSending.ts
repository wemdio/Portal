/**
 * ENG: СТАРТ и ПАУЗА кампаний запуска из английского кабинета (S2, решение
 * владельца 10–11.10.2026: «Launch» начинает отправку, клиент сам ставит паузу
 * и возобновляет).
 *
 * Общее ядро запуска (launchTemplate.runHeTemplateLaunch) кампании НЕ
 * стартует — его зовёт и RU staff-инструмент. Стартует только этот модуль, и
 * зовут его роуты английского кабинета: запуск
 * (api/client/eng/templates/[id]/launch) — после успешного ядра, и
 * «Start sending» / «Resume» (api/client/eng/templates/[id]/sending), — и
 * ночной долив ENG (stages/baseCollectRefill.ts, via 'refill'): завершённую
 * основную кампанию, в которую он принял новые контакты.
 *
 * СТАРТ (startHeEngLaunchSending) — fail-closed, по порядку, до первого вызова
 * рассыльщика:
 *  1. шаблон принадлежит проекту клиента, проект us;
 *  2. запись о запуске есть и не в аренде (запуск не идёт сейчас); у вызова из
 *     запуска — в записи БД есть все кампании ответа ядра (иначе итоговая
 *     запись не сохранилась — стартовать по ней нельзя); у кнопки — запуск
 *     создан не до self-serve отправки проекта
 *     (engCampaignStatus.heEngLaunchPredatesSelfServe: его кампании — из ящиков
 *     другого пресета);
 *  3. письма шаблона проходят гейт подстановок (тот же признак, что
 *     `needs_rewrite` кабинета) — шаблон, который ядро запуска отказало бы,
 *     не стартует; и в них нет строк отказа от писем и прощания
 *     (letterBrandGuard.heTemplateOptOutLines, правило владельца);
 *  4. выключатель отправки аккаунта (engSendingAccess, fail-closed);
 *  5. желание клиента: запуск не снимает паузу, поставленную клиентом;
 *  6. ящики пула проекта (sendingPool.readHeSendingPoolAssignment), ни один
 *     не стоит в пресете другого клиента или живом запуске RU-кабинета
 *     (sendingPool.findHeSendingPoolMailboxUses — у всех путей, у запуска тоже:
 *     проверка выдачи того же запроса была до минут ядра), и воркспейс пресета записи о запуске (пресет —
 *     только самого клиента: кампании запуска сотрудника с чужим пресетом не
 *     стартуют);
 *  6b. у запуска ('launch') — ни одна кампания записи не стоит на паузе (2) у
 *     рассыльщика: иначе не стартует ничего (`clientPaused`, `pausedFound`) —
 *     пауза могла быть Pause клиента, чьё желание не записалось (правило и
 *     довод — у шага в коде);
 *  7. желание «отправлять»: кнопка пишет его, только если оно не поменялось с
 *     чтения шага 5 (иначе перечитывает; стала пауза — отказ
 *     'client_paused_meanwhile'), запуск — только если строки нет, и затем
 *     перечитывает: стала пауза — как пауза клиента.
 * Затем по кампаниям с адресами, по одной: живое чтение (GET /campaigns/{id}),
 * адреса кампании ⊆ ящики проекта и тот же воркспейс
 * (checkHeCampaignAgainstAssignment), статус: 1/4 — уже отправляет (ничего не
 * делаем), 3 — завершена (не трогаем; у 'refill' — POST /activate, а 0/2 он не
 * трогает), 0/2 — POST /activate, -99/-1/-2 — никогда
 * не стартуем (команде алерт), прочее — не стартуем. Прямо перед КАЖДЫМ POST
 * /activate выключатель аккаунта и желание клиента читаются заново: сотрудник
 * мог выключить отправку, клиент — нажать Pause, пока шёл цикл (старт длится
 * до десятков секунд); Pause или непрочитанное желание — стоп цикла и пауза
 * стартованного (шаг 9). Старт без
 * повторов на 429 и со сроком; неудача или неясный ответ — одно проверочное
 * чтение статуса, без второго старта. Подтверждено, только если рассыльщик
 * вернул 1/4.
 * После цикла — желание клиента и выключатель читаются ещё раз: если за это
 * время клиент нажал Pause или сотрудник выключил отправку аккаунта, на паузу
 * ставится каждая кампания, которой этот вызов ОТПРАВИЛ POST /activate, — и
 * подтверждённая, и с неясным ответом (неясный старт мог доехать до
 * рассыльщика позже проверочного чтения). Желание клиента не прочиталось и со
 * второго раза — так же (fail-closed), и клиенту отказ. Неясный старт с
 * непрочитанным подтверждением пишет статус «не знаем» (кабинет предлагает
 * Pause, код 'start_unconfirmed' — не «не стартована»). Проверочное чтение мимо
 * общего ограничителя — только после неясного ответа (actionAnswerAmbiguous).
 *
 * ПАУЗА (pauseHeEngLaunchSending) — сначала записывается желание клиента
 * (его читают доводка паузы в engCampaignStatus и проверка ночного долива
 * createHeRefillSendGate в autoPipeline.ts; не записалось — один повтор, и
 * алерт 'pause_failed' говорит команде, держит ли эту паузу кто-то), затем POST
 * /pause каждой кампании записи; неясный ответ — проверочное чтение. Пауза не
 * спрашивает ни выключатель, ни ящики: остановить отправку можно всегда.
 * Воркспейс паузы — тот, в котором кампания нашлась при удачном живом чтении
 * (строка he_eng_campaign_status); только там «404» значит «кампании нет»
 * (= не отправляет). Кампания, которую ни разу не читали удачно, ставится на
 * паузу в воркспейсе пресета записи о запуске (иначе — ящиков пула), и «404»
 * там — НЕ пауза: неудача и алерт.
 * Пауза блокировки и разблокировки ('staff_block', engAccountBlock): кампания
 * без воркспейса и с «404» в запасном — не неудача, а `unreachable` (кабинет
 * до неё не дотягивается — её ставит на паузу человек), если все чтения по
 * дороге удались и записанного воркспейса без ключа у неё нет (иначе
 * неудача: это сбой чтения или настройки); «404» в запасном процесс помнит
 * (blockAbsentAt), и следующие нажатия называют такую кампанию без вызова. У
 * разблокировки (`confirmedSinceMs`) кампания, чей не отправляющий статус уже
 * прочитан после начала блокировки, второй раз не ставится — засчитывается
 * (`confirmedEarlier`).
 *
 * ВРЕМЯ. Вызывающий передаёт срок (`deadlineMs`): кампания начинается, только
 * если до срока остаётся PER_CAMPAIGN_BUDGET_MS (у разблокировки — свой
 * `campaignReserveMs`); остальные — `notAttempted` (кабинет говорит, что их
 * надо стартовать кнопкой).
 *
 * client_instantly_access и client_campaign_launches этот модуль НЕ пишет:
 * RU-роуты api/client/campaigns/[id]/activate|pause рынка не проверяют и
 * пустили бы ENG-клиента к старту мимо этих проверок.
 *
 * НЕ БРОСАЕТ: каждый исход — значение.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { activateCampaign, getCampaign, pauseCampaign } from '@/lib/instantly/client';
import { InstantlyApiError } from '@/lib/instantly/errors';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { CampaignStatus } from '@/lib/instantly/types';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { parseLaunchInfo, readHeLaunchLease, type HeTemplateLaunchInfo } from './launchHandoff';
import { heTemplateNeedsRewrite } from './clientEngProjection';
import { describeHeOptOutLines, heBrandNeedsOwner, heTemplateOptOutLines, readHeBrandEngClient } from './letterBrandGuard';
import {
  checkHeCampaignAgainstAssignment,
  describeHeSendingPoolMailboxUses,
  findHeSendingPoolMailboxUses,
  HE_SENDING_POOL_TABLE,
  readHeSendingPoolAssignment,
} from './sendingPool';
import {
  ENG_SENDING_ACCESS_BLIP_TEXT,
  ENG_SENDING_ACCESS_PROBLEM_TEXT,
  heEngSendingAccessAllows,
  heEngSendingAccessRefusal,
  readHeEngSendingAccess,
  requireHeEngSendingAccess,
  type HeEngSendingAccessState,
} from './engSendingAccess';
import { notifyHeEngSending, type HeEngSendingSetupCause } from './engSendingAlert';
import {
  HE_ENG_LAUNCH_SENDING_TABLE,
  heEngCampaignsDueForRefresh,
  heEngLaunchCampaigns,
  heEngLaunchPredatesSelfServe,
  heEngSendingAccessView,
  heEngStatusIsSending,
  heEngStatusIsStartable,
  heEngStatusIsStopped,
  heEngWorkspaceConfigured,
  readHeEngCampaignStatusRows,
  readHeEngClientStates,
  readHeEngPoolAssignedSince,
  refreshHeEngCampaignStatuses,
  summarizeHeEngSending,
  warnHeEngSendingDegraded,
  writeHeEngCampaignStatus,
  type HeEngCampaignStatusRow,
  type HeEngClientState,
  type HeEngSendingSummary,
  type HeEngStartErrorCode,
} from './engCampaignStatus';
import type { HeEngUnreachableCampaign } from './engAccountBlockMarker';

/** Метка счётчика использования рассыльщика (instantly_api_usage_hourly). */
export const HE_ENG_SENDING_CONSUMER = 'he_eng_sending';
const READ_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 15_000;
const READBACK_TIMEOUT_MS = 5_000;
/**
 * ЭВРИСТИЧЕСКИЙ запас на одну кампанию, а НЕ её худший случай: кампания
 * (старт или пауза) начинается, только если до срока вызывающего столько
 * осталось (пауза разблокировки задаёт свой запас — `campaignReserveMs`:
 * кампанию, чья пауза подтвердится уже после её срока, засчитает следующее
 * нажатие по записанному статусу). Обычно
 * ответы рассыльщика приходят за доли секунды, и 20 с хватает
 * с запасом. Худший случай больше: старт — чтение (READ_TIMEOUT_MS), POST
 * /activate (ACTION_TIMEOUT_MS) и проверочное чтение (READBACK_TIMEOUT_MS) =
 * 30 с, пауза — POST /pause и проверочное чтение = 20 с; если общий
 * ограничитель воркспейса включён (INSTANTLY_RATE_LIMITER_ENABLED=1), перед
 * каждым вызовом через него — ещё до INSTANTLY_RATE_LIMITER_MAX_WAIT_MS
 * (по умолчанию 15 с) ожидания (проверочное чтение после неясного ответа идёт
 * мимо него). Поэтому вызов, начавший кампанию у самого срока, может выйти за
 * `deadlineMs` на разницу худшего случая и запаса. Шаг 9 старта (пауза
 * стартованного этим вызовом, если клиент нажал Pause или сотрудник выключил
 * отправку) идёт ПОСЛЕ цикла и сроком не ограничен: остановку не обрезаем.
 */
const PER_CAMPAIGN_BUDGET_MS = 20_000;

/* ─────────────── Тексты клиенту ─────────────── */

export const ENG_START_NOT_LAUNCHED_TEXT = 'This template has not been launched yet.';
export const ENG_START_LAUNCH_RUNNING_TEXT =
  'This launch is still being created. Try again in a few minutes.';
export const ENG_START_LETTERS_TEXT =
  'The letters of this template need rewriting, so its campaigns cannot be started. Message Support to have them rewritten.';
export const ENG_START_NO_MAILBOXES_TEXT =
  'The campaigns of this launch cannot be started from here because no sending mailboxes are set up for your project. '
  + 'Message Support.';
/**
 * Запуск создан до self-serve отправки проекта (heEngLaunchPredatesSelfServe):
 * раньше, чем проекту отданы ящики пула, или проекту их не отдавали вовсе.
 * Правда для обоих: в момент создания отправка проекта настроена не была.
 */
export const ENG_START_PRE_SELF_SERVE_TEXT =
  'This launch was created before sending was set up for your project, so its campaigns cannot be started from here. '
  + 'Message Support.';
/**
 * Желание клиента после цикла старта не прочиталось и при повторе: стартованное
 * этим вызовом поставлено на паузу (fail-closed, шаг 9). Читается и само, и
 * после «Sending was not started: » (роут запуска).
 */
export const ENG_START_STATE_UNCONFIRMED_TEXT =
  'Because of a problem on our side we could not confirm that this market should keep sending, so the campaigns '
  + 'we were starting are paused. Try again in a minute; if it keeps failing, message Support.';
/** То же, но пауза части кампаний не подтвердилась — команде ушёл алерт 'pause_failed'. */
export const ENG_START_STATE_UNCONFIRMED_PAUSE_FAILED_TEXT =
  'Because of a problem on our side we could not confirm that this market should keep sending, so we paused the '
  + 'campaigns we were starting, but some of them could not be paused yet and may still be sending — our team is '
  + 'stopping them. Message Support.';
/**
 * Кнопка старта: между чтением желания клиента и его записью «отправлять»
 * клиент (другая вкладка) нажал Pause — старт ничего не начинает. Без кнопки:
 * какая теперь на карточке, решает свежая сводка.
 */
export const ENG_START_PAUSED_MEANWHILE_TEXT =
  'You paused this market while sending was starting, so nothing more was started.';
const TEMPLATE_NOT_FOUND_TEXT = 'Template not found';

/* ─────────────── Результаты ─────────────── */

export interface HeEngSendingRefusal {
  kind: 'refused';
  status: number;
  /** Машинный код (кабинет различает выключатель и «нечего стартовать»). */
  code: string;
  /** Английская фраза клиенту. */
  message: string;
}

export interface HeEngStartFailure {
  campaignId: string;
  code: HeEngStartErrorCode;
}

export interface HeEngStartDone {
  kind: 'done';
  /** Кампаний с адресами в записи. */
  campaigns: number;
  started: number;
  alreadySending: number;
  completed: number;
  failed: HeEngStartFailure[];
  /** Не начаты — не хватило времени запроса. */
  notAttempted: number;
  /** Только 'refill': стоящие (0/2) кампании — долив их не стартует. */
  left: number;
  /**
   * Клиент поставил запуск на паузу — запуск её не снимает, ничего не
   * стартовано. Ставит и проверка запуска 'launch' (шаг 6b): у рассыльщика
   * есть кампания на паузе (2) — тогда `pausedFound` > 0.
   */
  clientPaused: boolean;
  /**
   * Только 'launch': кампаний записи на паузе у рассыльщика (2), из-за которых
   * запуск не стартовал ничего (шаг 6b); 0 — не было или не проверялось.
   */
  pausedFound: number;
  /**
   * Старт НЕЯСЕН ('start_unconfirmed'): POST /activate без ответа, проверочное
   * чтение не удалось — кампания могла начать отправку. Не входит ни в
   * `started`, ни в `failed`.
   */
  unconfirmed: number;
  /** Стартовано и тут же поставлено на паузу: клиент нажал Pause во время старта. */
  compensated: number;
  /**
   * Клиент нажал Pause во время старта, а пауза кампании, которой этот вызов
   * отправил POST /activate, не подтвердилась — она может отправлять (команде
   * ушёл алерт 'pause_failed').
   */
  compensationFailed: number;
}

export type HeEngStartResult = HeEngSendingRefusal | HeEngStartDone;

export interface HeEngPauseDone {
  kind: 'done';
  campaigns: number;
  /** Не отправляют после вызова (поставлены на паузу или уже стояли). */
  paused: number;
  /** Рассыльщик не подтвердил паузу — могут отправлять. */
  failed: string[];
  notAttempted: number;
  /** Желание клиента записано (he_eng_launch_sending). */
  stateRecorded: boolean;
  /** Только 'staff_block': из `paused` — засчитаны по чтению после начала блокировки (`confirmedSinceMs`). */
  confirmedEarlier: number;
  /** Только 'staff_block': кабинету недоступны (не в `failed`); у остальных пауз — в `failed`. */
  unreachable: HeEngUnreachableCampaign[];
}

export type HeEngPauseResult = HeEngSendingRefusal | HeEngPauseDone;

function refused(status: number, code: string, message: string): HeEngSendingRefusal {
  return { kind: 'refused', status, code, message };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pgText(prefix: string, error: { code?: string | null; message?: string | null } | null | undefined): string {
  return `${prefix}: ${error?.code ?? 'error'} ${String(error?.message ?? '').slice(0, 200)}`.trim();
}

/* ─────────────── Общее: шаблон, запись, воркспейс ─────────────── */

interface LoadedLaunch {
  kind: 'loaded';
  template: Record<string, unknown>;
  launch: HeTemplateLaunchInfo;
  runningUntilMs: number | null;
  /**
   * Сайт, бриф и владелец проекта — гейту писем старта (чужая компания в
   * письмах, heTemplateNeedsRewrite; владелец решает, проверяются ли русские
   * письма — letterBrandGuard.heEngClient).
   */
  project: { website_url?: unknown; brief?: unknown; created_by?: unknown };
}

/**
 * Шаблон проекта и его запись о запуске. Принадлежность: шаблон → вертикаль →
 * проект `projectId`, проект создан `ownerUserId` и рынка us.
 */
async function loadLaunch(
  portalDb: SupabaseClient,
  args: { ownerUserId: string; projectId: string; templateId: string; columns: string },
): Promise<LoadedLaunch | HeEngSendingRefusal> {
  const { data: tplRow, error: tplErr } = await portalDb
    .from('he_templates')
    .select(args.columns)
    .eq('id', args.templateId)
    .maybeSingle();
  if (tplErr) {
    void logWarn('he.eng_sending.read_failed', pgText('he_templates read', tplErr), { templateId: args.templateId });
    return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
  }
  const template = (tplRow ?? null) as Record<string, unknown> | null;
  if (!template) return refused(404, 'not_found', TEMPLATE_NOT_FOUND_TEXT);
  const { data: vertRow, error: vertErr } = await portalDb
    .from('he_verticals')
    .select('project_id')
    .eq('id', String(template.vertical_id ?? ''))
    .maybeSingle();
  if (vertErr) return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
  if ((vertRow as { project_id?: unknown } | null)?.project_id !== args.projectId) {
    return refused(404, 'not_found', TEMPLATE_NOT_FOUND_TEXT);
  }
  const { data: projRow, error: projErr } = await portalDb
    .from('he_projects')
    .select('created_by, market, website_url, brief')
    .eq('id', args.projectId)
    .maybeSingle();
  if (projErr) return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
  const project = projRow as { created_by?: unknown; market?: unknown; website_url?: unknown; brief?: unknown } | null;
  if (!project || project.created_by !== args.ownerUserId || project.market !== 'us') {
    return refused(404, 'not_found', TEMPLATE_NOT_FOUND_TEXT);
  }
  const launch = parseLaunchInfo(template.launch_info);
  if (!launch) return refused(404, 'not_launched', ENG_START_NOT_LAUNCHED_TEXT);
  return {
    kind: 'loaded',
    template,
    launch,
    runningUntilMs: readHeLaunchLease(template.launch_info).runningUntilMs,
    project: { website_url: project.website_url, brief: project.brief, created_by: project.created_by },
  };
}

/**
 * Воркспейс кампаний запуска — пресета ЗАПИСИ о запуске, и только если это
 * пресет самого клиента (ядро создало кампании в его воркспейсе). null —
 * пресета нет / чужой / воркспейс не настроен в окружении.
 */
async function launchWorkspace(
  instantlyDb: SupabaseClient,
  ownerUserId: string,
  presetId: string,
): Promise<
  | { kind: 'ok'; accountId: string }
  | { kind: 'missing'; cause: Extract<HeEngSendingSetupCause, `preset_${string}` | 'workspace_unconfigured'>; detail: string }
  | { kind: 'error' }
> {
  if (!presetId) return { kind: 'missing', cause: 'preset_missing', detail: 'launch record has no preset_id' };
  const { data, error } = await instantlyDb
    .from('client_campaign_presets')
    .select('instantly_account_id')
    .eq('id', presetId)
    .eq('client_user_id', ownerUserId)
    .maybeSingle();
  if (error) return { kind: 'error' };
  if (!data) return { kind: 'missing', cause: 'preset_foreign', detail: 'launch preset is not this client’s preset' };
  const accountId = resolveInstantlyAccountId((data as { instantly_account_id?: string | null }).instantly_account_id ?? null);
  if (!heEngWorkspaceConfigured(accountId)) {
    return { kind: 'missing', cause: 'workspace_unconfigured', detail: `launch preset workspace ${accountId} is not configured` };
  }
  return { kind: 'ok', accountId };
}

/** Записать желание клиента. `onlyIfAbsent` — не перезаписывать существующее. */
async function writeClientState(
  portalDb: SupabaseClient,
  args: { templateId: string; state: HeEngClientState; onlyIfAbsent: boolean },
): Promise<boolean> {
  try {
    const { error } = await portalDb
      .from(HE_ENG_LAUNCH_SENDING_TABLE)
      .upsert(
        {
          template_id: args.templateId,
          client_state: args.state,
          changed_at: new Date().toISOString(),
        },
        { onConflict: 'template_id', ignoreDuplicates: args.onlyIfAbsent },
      );
    if (error) {
      warnHeEngSendingDegraded('state_write', pgText('he_eng_launch_sending upsert', error), { templateId: args.templateId });
      return false;
    }
    return true;
  } catch (e) {
    warnHeEngSendingDegraded('state_write', `he_eng_launch_sending upsert threw: ${String(e).slice(0, 200)}`, {});
    return false;
  }
}

/**
 * Записать желание 'sending' кнопки старта, только если оно не поменялось с
 * чтения шага 5: строка была — условное обновление по тому же changed_at;
 * строки не было — только вставка (конфликт — ничего). 'written' — записано;
 * 'changed' — строку за это время переписали (перечитать); 'error' — сбой.
 */
async function writeClientStateIfUnchanged(
  portalDb: SupabaseClient,
  args: { templateId: string; expected: { state: HeEngClientState; changedAt: string | null } | null },
): Promise<'written' | 'changed' | 'error'> {
  const now = new Date().toISOString();
  try {
    const res =
      args.expected === null
        ? await portalDb
            .from(HE_ENG_LAUNCH_SENDING_TABLE)
            .upsert(
              { template_id: args.templateId, client_state: 'sending', changed_at: now },
              { onConflict: 'template_id', ignoreDuplicates: true },
            )
            .select('template_id')
        : args.expected.changedAt === null
          ? // changed_at not null в схеме — сюда не попадаем; без условия нечем сравнить.
            await portalDb
              .from(HE_ENG_LAUNCH_SENDING_TABLE)
              .update({ client_state: 'sending', changed_at: now })
              .eq('template_id', args.templateId)
              .eq('client_state', args.expected.state)
              .select('template_id')
          : await portalDb
              .from(HE_ENG_LAUNCH_SENDING_TABLE)
              .update({ client_state: 'sending', changed_at: now })
              .eq('template_id', args.templateId)
              .eq('changed_at', args.expected.changedAt)
              .select('template_id');
    if (res.error) {
      warnHeEngSendingDegraded('state_write', pgText('he_eng_launch_sending conditional write', res.error), {
        templateId: args.templateId,
      });
      return 'error';
    }
    return Array.isArray(res.data) && res.data.length > 0 ? 'written' : 'changed';
  } catch (e) {
    warnHeEngSendingDegraded('state_write', `he_eng_launch_sending conditional write threw: ${String(e).slice(0, 200)}`, {});
    return 'error';
  }
}

/**
 * Ответ действия (POST /activate, POST /pause) неясен: срок истёк, запрос
 * оборвался или упал транспорт (бросил не InstantlyApiError), либо 2xx пришёл
 * без статуса — рассыльщик мог действие применить, а мог нет. Отказ с HTTP-кодом
 * (InstantlyApiError, в том числе 429) — ответ ясный.
 */
function actionAnswerAmbiguous(answer: { threw: unknown } | { status: number | null }): boolean {
  if ('threw' in answer) return !(answer.threw instanceof InstantlyApiError);
  return answer.status === null;
}

/**
 * Статус кампании после действия — одно короткое проверочное чтение. Мимо
 * очереди общего ограничителя — только после НЕЯСНОГО ответа
 * (actionAnswerAmbiguous): тогда важна скорость подтверждения. После ясного
 * ответа (HTTP-отказ, в том числе 429, или 2xx со статусом) — через
 * ограничитель, как любой вызов: отказ по частоте не повторяется в обход
 * общего бюджета воркспейса.
 */
async function readBack(
  campaignId: string,
  accountId: string,
  opts: { ambiguous: boolean },
): Promise<{ status: number | null; notFound: boolean }> {
  try {
    const back = await getCampaign(campaignId, {
      accountId,
      retryRateLimits: false,
      skipRateLimiter: opts.ambiguous,
      timeoutMs: READBACK_TIMEOUT_MS,
      consumer: HE_ENG_SENDING_CONSUMER,
    });
    return { status: num(back?.status), notFound: false };
  } catch (e) {
    return { status: null, notFound: e instanceof InstantlyApiError && e.status === 404 };
  }
}

/**
 * Поставить одну кампанию на паузу. 'paused' — после вызова она не
 * отправляет; 'failed' — пауза не подтверждена (отказ, в том числе 429,
 * неясный ответ без подтверждения). `trust404` — воркспейс проверен (кампания
 * в нём уже находилась при удачном чтении): «404» значит «кампании нет», это
 * не отправка ('paused'). Без проверенного воркспейса «404» значит лишь «не в
 * этом воркспейсе» — 'absent': где она, кабинет не знает.
 */
async function pauseOne(
  portalDb: SupabaseClient,
  projectId: string,
  campaignId: string,
  accountId: string,
  trust404: boolean,
): Promise<'paused' | 'failed' | 'absent'> {
  let after: number | null = null;
  let ambiguous: boolean;
  try {
    const res = await pauseCampaign(campaignId, {
      accountId,
      retryRateLimits: false,
      timeoutMs: ACTION_TIMEOUT_MS,
      consumer: HE_ENG_SENDING_CONSUMER,
    });
    after = num(res?.status);
    ambiguous = actionAnswerAmbiguous({ status: after });
  } catch (e) {
    after = null;
    ambiguous = actionAnswerAmbiguous({ threw: e });
  }
  if (after === null || heEngStatusIsSending(after)) {
    const back = await readBack(campaignId, accountId, { ambiguous });
    if (back.notFound) {
      if (!trust404) return 'absent';
      await writeHeEngCampaignStatus(portalDb, projectId, campaignId, { readError: 'not_found' });
      return 'paused';
    }
    after = back.status;
  }
  if (after === null) return 'failed';
  await writeHeEngCampaignStatus(portalDb, projectId, campaignId, {
    status: after,
    readError: null,
    workspace: accountId,
  });
  return heEngStatusIsSending(after) ? 'failed' : 'paused';
}

/**
 * Пауза кампании уже подтверждена чтением (пауза разблокировки, `sinceMs`):
 * в строке кэша не отправляющий статус, прочитанный у рассыльщика не раньше
 * `sinceMs` (статус и время чтения пишут вместе живое чтение, пауза, старт и
 * гейт ночи). Тот же признак, что у pauseOne: не 1/4 — стоит, завершена,
 * черновик или остановлена рассыльщиком.
 */
function pausedSince(row: HeEngCampaignStatusRow | undefined, sinceMs: number): boolean {
  if (!row || row.status === null || heEngStatusIsSending(row.status)) return false;
  const readAt = row.status_read_at ? Date.parse(row.status_read_at) : Number.NaN;
  return Number.isFinite(readAt) && readAt >= sinceMs;
}

/**
 * Пауза блокировки и разблокировки: где этот процесс уже получил «404»
 * запасного воркспейса (ключ «кампания|воркспейс» → когда). Id кампании у
 * рассыльщика в другой воркспейс не переезжает, поэтому следующие нажатия, пока
 * не прошло HE_ENG_BLOCK_ABSENT_MEMORY_MS, называют такую кампанию недоступной
 * без вызова: иначе её POST /pause и проверочное чтение на каждом нажатии
 * съедают у общего ограничителя срок нажатия, и до остальных кампаний очередь
 * не доходит. Только память процесса: после рестарта — один вызов снова.
 */
const HE_ENG_BLOCK_ABSENT_MEMORY_MS = 30 * 60_000;
const blockAbsentAt = new Map<string, number>();

/** Имена кампаний записи о запуске — для строки «поставьте на паузу руками». */
function launchCampaignNames(launch: HeTemplateLaunchInfo): Map<string, string> {
  const out = new Map<string, string>();
  if (launch.campaign_name) out.set(launch.campaign_id, launch.campaign_name);
  for (const c of launch.campaigns ?? []) if (c.campaign_name) out.set(c.campaign_id, c.campaign_name);
  return out;
}

/* ─────────────── Старт ─────────────── */

export async function startHeEngLaunchSending(input: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  clientUserId: string;
  projectId: string;
  templateId: string;
  /**
   * 'launch' — сразу после ядра запуска; 'start' — кнопки «Start sending» /
   * «Resume»; 'refill' — повторный старт после ночного долива
   * (stages/baseCollectRefill.ts, «ПОВТОРНЫЙ СТАРТ»: ночь приняла контакты в
   * ЗАВЕРШЁННУЮ основную кампанию — новые адреса в завершённой кампании сами
   * не уходят): только у запуска, где клиент просил отправку (желание
   * 'sending'; его не пишет), стартует только завершённые (3) кампании из
   * `onlyCampaignIds`; стоящие (0/2) не трогает (`left`), остановленные
   * рассыльщиком — никогда; отправляющая (1/4) — `alreadySending`, повтор
   * ничего не делает. Все прочие проверки — те же, что у кнопки.
   */
  via: 'launch' | 'start' | 'refill';
  /** Только 'launch': кампании ответа ядра — все обязаны быть в записи БД. */
  expectedCampaignIds?: string[];
  /**
   * Ограничить кампании записи этими id. У 'refill' — кампании, в которые
   * долив этой ночью ПРИНЯЛ адреса: они идут в старт и тогда, когда счёт
   * адресов записи о запуске у них нулевой (запись счёт ночей не ведёт).
   */
  onlyCampaignIds?: string[];
  deadlineMs: number;
}): Promise<HeEngStartResult> {
  const { portalDb, instantlyDb, clientUserId, projectId, templateId, via } = input;
  const ctx = { userId: clientUserId, projectId, templateId, via };
  try {
    // 1–2. Шаблон, принадлежность, запись о запуске.
    const loaded = await loadLaunch(portalDb, {
      ownerUserId: clientUserId,
      projectId,
      templateId,
      columns: 'id, vertical_id, base_id, status, launch_info, letters, personalization_plan',
    });
    if (loaded.kind === 'refused') return loaded;
    const { template, launch } = loaded;
    if (loaded.runningUntilMs !== null && loaded.runningUntilMs > Date.now()) {
      return refused(409, 'launch_running', ENG_START_LAUNCH_RUNNING_TEXT);
    }
    const campaigns = heEngLaunchCampaigns(launch);
    if (input.expectedCampaignIds) {
      const recorded = new Set(campaigns.map((c) => c.campaignId));
      const missing = input.expectedCampaignIds.filter((id) => id && !recorded.has(id));
      if (missing.length > 0) {
        void logWarn('he.eng_sending.record_mismatch', 'launch record in the DB lacks campaigns of the launch answer — not started', {
          ...ctx,
          missing: missing.length,
        });
        return refused(409, 'record_mismatch', ENG_SENDING_ACCESS_PROBLEM_TEXT);
      }
    }
    // Запуск до self-serve отправки проекта — его кампании из ящиков другого
    // пресета, кабинет их не стартует (сводка кнопку и не рисует). До
    // выключателя: такой отказ не должен звать команду включать отправку. У
    // 'launch' запись только что написана этим запросом — после выдачи ящиков.
    if (via !== 'launch') {
      const assignedSince = await readHeEngPoolAssignedSince(portalDb, [projectId]);
      if (heEngLaunchPredatesSelfServe(launch, projectId, assignedSince)) {
        return refused(409, 'pre_self_serve', ENG_START_PRE_SELF_SERVE_TEXT);
      }
    }

    // 3. Гейт писем — тот же признак, что у кабинета (needs_rewrite): обе
    //    причины ядра запуска (шаг 4b″) — подстановки и чужая компания в
    //    письмах (с сайтом и брифом проекта, letterBrandGuard).
    if (template.status !== 'ready') return refused(409, 'letters_need_rewrite', ENG_START_LETTERS_TEXT);
    let base: Record<string, unknown> | undefined;
    if (typeof template.base_id === 'string' && template.base_id) {
      const { data: baseRow, error: baseErr } = await portalDb
        .from('he_bases')
        .select('id, columns, sample_rows')
        .eq('id', template.base_id)
        .maybeSingle();
      if (baseErr) return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
      base = (baseRow ?? undefined) as Record<string, unknown> | undefined;
    }
    // Владелец — клиент ENG-кабинета: его письма проверяются на любом языке;
    // профиль читается, только когда он меняет ответ (heBrandNeedsOwner).
    const heEngClient = heBrandNeedsOwner(template.letters)
      ? await readHeBrandEngClient(portalDb, loaded.project.created_by)
      : false;
    if (heTemplateNeedsRewrite(template, base, 'us', { ...loaded.project, heEngClient })) {
      return refused(409, 'letters_need_rewrite', ENG_START_LETTERS_TEXT);
    }
    // 3′. Строки отказа от писем и прощания (правило владельца,
    //     letterBrandGuard.heTemplateOptOutLines; английские письма us-проекта):
    //     модель могла нарушить запрет промпта, клиент — дописать строку.
    //     С 14.10.2026 то же правило отказывает раньше — в предполёте ядра
    //     запуска (launchTemplate, шаг 4b″, 'template_opt_out_lines'), до
    //     классификатора и рассыльщика; здесь — последняя страховка для
    //     кампаний, созданных до этого. Признак `needs_rewrite` кабинета
    //     (heTemplateRewriteReasons) этой причины пока не знает, поэтому
    //     текст — общий «письма нужно переписать, напишите в Support»: он
    //     верен и для неё.
    const optOut = heTemplateOptOutLines('us', template.letters);
    if (optOut.length > 0) {
      void logWarn('he.eng_sending.opt_out_lines', 'template letters offer an opt-out or say it is the last email — not started', {
        ...ctx,
        detail: describeHeOptOutLines(optOut),
      });
      return refused(409, 'letters_need_rewrite', ENG_START_LETTERS_TEXT);
    }

    // 4. Выключатель аккаунта. Долив клиента не ждёт и команду не зовёт —
    //    только читает выключатель; код отказа — тот же, что у кнопки
    //    (выключена / не включена / не читается): долив по нему решает, держать
    //    ли следующие ночи (stages/baseCollectRefill.ts, heRefillMainRestartVerdict).
    if (via === 'refill') {
      const access = await readHeEngSendingAccess(portalDb, clientUserId);
      if (!heEngSendingAccessAllows(access.state)) {
        const refusal = heEngSendingAccessRefusal(access.state);
        return refused(refusal?.status ?? 503, refusal?.code ?? 'sending_access_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
      }
    } else {
      const gate = await requireHeEngSendingAccess(portalDb, clientUserId, { projectId, via });
      if (!gate.ok) return refused(gate.status, gate.code, gate.message);
    }

    // 5. Желание клиента.
    const states = await readHeEngClientStates(portalDb, [templateId]);
    if (states === null) return refused(503, 'sending_state_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
    const current = states.get(templateId)?.state ?? null;
    const only = input.onlyCampaignIds ? new Set(input.onlyCampaignIds) : null;
    // Долив: адреса в кампаниях `onlyCampaignIds` он только что принял сам.
    const withLeads = campaigns.filter((c) =>
      via === 'refill' && only ? only.has(c.campaignId) : c.leads > 0 && (!only || only.has(c.campaignId)),
    );
    const done: HeEngStartDone = {
      kind: 'done',
      campaigns: withLeads.length,
      started: 0,
      alreadySending: 0,
      completed: 0,
      failed: [],
      notAttempted: 0,
      left: 0,
      clientPaused: false,
      pausedFound: 0,
      unconfirmed: 0,
      compensated: 0,
      compensationFailed: 0,
    };
    if (via === 'launch' && current === 'paused') return { ...done, clientPaused: true };
    // Долив стартует только запуск, где клиент сам просил отправку.
    if (via === 'refill' && current !== 'sending') return { ...done, clientPaused: current === 'paused' };

    // 6. Ящики пула проекта и воркспейс записи о запуске.
    const assignment = await readHeSendingPoolAssignment(portalDb, projectId);
    if (assignment.kind === 'none') return refused(409, 'sending_mailboxes_missing', ENG_START_NO_MAILBOXES_TEXT);
    if (assignment.kind === 'error') return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
    if (assignment.kind !== 'assigned') {
      void notifyHeEngSending({
        kind: 'setup_unavailable',
        projectId,
        templateId,
        cause: assignment.kind === 'mixed' ? 'pool_mixed' : 'pool_missing',
        detail:
          assignment.kind === 'mixed'
            ? `pool mailboxes of the project are in several workspaces: ${assignment.workspaces.join(', ')}`
            : 'he_sending_pool is missing (migration 20261011_0001)',
      });
      return refused(503, 'sending_setup_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
    }
    // Ящик пула не стоит ни в пресете ДРУГОГО клиента, ни в живом запуске
    // RU-кабинета — та же проверка, что у запуска (engSendingPreset, шаг 6) и
    // ночного долива (createHeRefillSendGate, шаг 5). У 'launch' — ТОЖЕ (аудит
    // 14.10.2026): выдача ящиков этого запроса (ensureHeEngPresetForProject)
    // проверяла их ДО ядра запуска, а ядро идёт минутами (платный
    // классификатор сегментов, загрузка адресов). Ящик, который за это время
    // сотрудник поставил в пресет RU-клиента, иначе ушёл бы в отправку двух
    // клиентов сразу. Одно чтение БД рассыльщика прямо перед стартом.
    {
      const uses = await findHeSendingPoolMailboxUses(instantlyDb, assignment.emails, {
        exceptPresetOfClient: clientUserId,
      });
      if (uses.kind === 'error') return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
      if (uses.kind === 'in_use') {
        void notifyHeEngSending({
          kind: 'setup_unavailable',
          projectId,
          templateId,
          cause: 'mailbox_in_use',
          detail: `ящик пула проекта уже используется: ${describeHeSendingPoolMailboxUses(uses.uses)}`,
        });
        return refused(503, 'sending_setup_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
      }
    }
    const workspace = await launchWorkspace(instantlyDb, clientUserId, launch.preset_id);
    if (workspace.kind === 'error') return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
    if (workspace.kind === 'missing') {
      void notifyHeEngSending({
        kind: 'setup_unavailable',
        projectId,
        templateId,
        cause: workspace.cause,
        detail: `${workspace.detail}; campaigns: ${campaigns.map((c) => c.campaignId).join(', ')}`,
      });
      return refused(503, 'sending_setup_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
    }
    const accountId = workspace.accountId;
    const options = { accountId, retryRateLimits: false, timeoutMs: READ_TIMEOUT_MS, consumer: HE_ENG_SENDING_CONSUMER };

    // 6b. ЗАПУСК НЕ СНИМАЕТ ПАУЗУ — и незаписанную. Правило: у 'launch' кампания
    //     в статусе 2 (Paused) у рассыльщика — запуск НЕ стартует НИЧЕГО (как
    //     при паузе клиента, `clientPaused`, `pausedFound`). Почему так:
    //      - ядро запуска создаёт кампании черновиками (0) и на паузу их не
    //        ставит; статус 2 рассыльщик даёт только кампании, которая
    //        отправляла и которую потом остановили: Pause клиента (в том числе
    //        та, чьё желание 'paused' не записалось), сотрудник у рассыльщика,
    //        выключение аккаунта, наша страховочная пауза шага 9;
    //      - желание 'sending' у 'launch' НЕ подтверждение клиента: запуск
    //        пишет его только если строки нет, а строка 'sending' могла
    //        остаться от прошлого старта, после которого Pause не записался;
    //        время строки тоже не подтверждение — после Pause кэш статуса
    //        перечитывается фоном и времени паузы не хранит. Подтверждение — только
    //        кнопка старта ('start': «Start sending» / «Start the rest» /
    //        «Resume»), которая сама переписывает желание и стартует и 2;
    //      - не стартовать и черновики: клиент, поставивший вертикаль на паузу,
    //        не ждёт, что «Launch all» (достройка) начнёт отправку новых
    //        сегментов.
    //     Прочитанное здесь цикл (шаг 8) не перечитывает. Чтение не удалось
    //     (не 404) — проверить паузу нечем: отказ, ничего не стартовано
    //     (fail-closed); срок кончился посреди проверки — непрочитанные цикл не
    //     начнёт (тот же срок).
    const preRead = new Map<string, { live: Awaited<ReturnType<typeof getCampaign>> } | { error: unknown }>();
    if (via === 'launch') {
      const pausedIds: string[] = [];
      for (const c of withLeads) {
        if (Date.now() + PER_CAMPAIGN_BUDGET_MS > input.deadlineMs) break;
        try {
          const live = await getCampaign(c.campaignId, options);
          preRead.set(c.campaignId, { live });
          if (live && live.id === c.campaignId && num(live.status) === CampaignStatus.Paused) pausedIds.push(c.campaignId);
        } catch (e) {
          preRead.set(c.campaignId, { error: e });
          if (!(e instanceof InstantlyApiError && e.status === 404)) {
            void logWarn('he.eng_sending.launch_precheck_failed', 'campaign not read before launch start — nothing started', {
              ...ctx,
              campaignId: c.campaignId,
            });
            return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
          }
        }
      }
      if (pausedIds.length > 0) {
        // Прочитанное — в кэш (статус и воркспейс, где кампания нашлась):
        // сводка в ответе запуска сразу видит паузу и называет ту кнопку,
        // что будет на карточке.
        for (const [campaignId, pre] of preRead) {
          if (!('live' in pre) || !pre.live || pre.live.id !== campaignId) continue;
          await writeHeEngCampaignStatus(portalDb, projectId, campaignId, {
            status: num(pre.live.status),
            readError: null,
            workspace: accountId,
          });
        }
        void logAudit('he.eng_sending.launch_kept_paused', 'launch found paused campaigns — nothing started', {
          ...ctx,
          paused: pausedIds.join(','),
        });
        return { ...done, clientPaused: true, pausedFound: pausedIds.length };
      }
    }

    // 7. Желание «отправлять»: кнопка — перезаписывает, но только то, что
    //    прочитал шаг 5 (то же changed_at; строки не было — только вставка):
    //    клиент мог нажать Pause в другой вкладке между чтением и записью —
    //    тогда перечитываем, и пауза останавливает старт. Запуск — только если
    //    клиент ещё ничего не записал (паузу клиента запуск не снимает); долив
    //    его не пишет (он стартует, только когда оно уже 'sending').
    if (via === 'start') {
      const write = await writeClientStateIfUnchanged(portalDb, {
        templateId,
        expected: states.get(templateId) ?? null,
      });
      if (write === 'error') return refused(503, 'sending_state_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
      if (write === 'changed') {
        const again = await readHeEngClientStates(portalDb, [templateId]);
        if (again === null) return refused(503, 'sending_state_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
        if (again.get(templateId)?.state !== 'sending') {
          void logAudit('he.eng_sending.start_paused_meanwhile', 'client paused between the state read and write — not started', ctx);
          return refused(409, 'client_paused_meanwhile', ENG_START_PAUSED_MEANWHILE_TEXT);
        }
      }
    } else if (via === 'launch') {
      const recorded = await writeClientState(portalDb, { templateId, state: 'sending', onlyIfAbsent: true });
      if (!recorded) return refused(503, 'sending_state_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
      // Запись «только если строки нет» не говорит, что в строке: клиент мог
      // нажать Pause между шагом 5 и записью — перечитываем.
      const again = await readHeEngClientStates(portalDb, [templateId]);
      if (again === null) return refused(503, 'sending_state_unavailable', ENG_SENDING_ACCESS_PROBLEM_TEXT);
      if (again.get(templateId)?.state === 'paused') return { ...done, clientPaused: true };
    }

    // 8. Кампании — по одной.
    const startedIds: string[] = [];
    /** Кампании, которым этот вызов отправил POST /activate (с любым ответом). */
    const attemptedIds: string[] = [];
    const mismatch: string[] = [];
    const mismatchReasons = new Set<string>();
    const stopped: Array<{ id: string; status: number | null }> = [];
    /** Выключатель перед стартом сказал «нельзя» окончательно (выключен / не включён). */
    let accessLost: HeEngSendingAccessState | null = null;
    /** Выключатель перед стартом не прочитался — дальше не стартуем (fail-closed). */
    let accessUnclear = false;
    /**
     * Желание клиента, перечитанное перед стартом кампании: 'paused' — клиент
     * нажал Pause посреди старта; 'unreadable' — не прочиталось. Оба — стоп
     * цикла, как accessLost, и (шаг 9) пауза стартованного этим вызовом.
     */
    let intentStop: 'paused' | 'unreadable' | null = null;
    const fail = async (
      campaignId: string,
      code: HeEngStartErrorCode,
      status?: number | null,
      readError?: 'not_found' | 'failed' | null,
    ) => {
      done.failed.push({ campaignId, code });
      await writeHeEngCampaignStatus(portalDb, projectId, campaignId, {
        ...(status !== undefined ? { status } : {}),
        ...(readError !== undefined ? { readError } : {}),
        startError: code,
      });
    };
    for (const c of withLeads) {
      if (accessLost || intentStop) break;
      if (accessUnclear) {
        // Выключатель не прочитался перед стартом прошлой кампании — эту не
        // проверяем и не стартуем; клиенту — «не проверили, повторите».
        await fail(c.campaignId, 'read_failed');
        continue;
      }
      if (Date.now() + PER_CAMPAIGN_BUDGET_MS > input.deadlineMs) {
        done.notAttempted += 1;
        continue;
      }
      let live: Awaited<ReturnType<typeof getCampaign>> | null = null;
      try {
        const pre = preRead.get(c.campaignId);
        if (pre && 'error' in pre) throw pre.error;
        live = pre ? pre.live : await getCampaign(c.campaignId, options);
      } catch (e) {
        if (e instanceof InstantlyApiError && e.status === 404) {
          stopped.push({ id: c.campaignId, status: null });
          await fail(c.campaignId, 'not_found', undefined, 'not_found');
        } else {
          await fail(c.campaignId, 'read_failed');
        }
        continue;
      }
      if (!live || live.id !== c.campaignId) {
        await fail(c.campaignId, 'read_failed');
        continue;
      }
      const status = num(live.status);
      // Кампания нашлась в этом воркспейсе — он проверен (пауза пойдёт сюда).
      const check = checkHeCampaignAgainstAssignment(assignment, { instantlyAccountId: accountId, emailList: live.email_list });
      if (!check.ok) {
        mismatch.push(c.campaignId);
        mismatchReasons.add(check.reason);
        done.failed.push({ campaignId: c.campaignId, code: 'mailboxes_changed' });
        await writeHeEngCampaignStatus(portalDb, projectId, c.campaignId, {
          status,
          readError: null,
          startError: 'mailboxes_changed',
          workspace: accountId,
        });
        continue;
      }
      if (heEngStatusIsSending(status)) {
        done.alreadySending += 1;
        await writeHeEngCampaignStatus(portalDb, projectId, c.campaignId, {
          status,
          readError: null,
          startError: null,
          workspace: accountId,
        });
        continue;
      }
      if (status === CampaignStatus.Completed && via !== 'refill') {
        done.completed += 1;
        await writeHeEngCampaignStatus(portalDb, projectId, c.campaignId, {
          status,
          readError: null,
          startError: null,
          workspace: accountId,
        });
        continue;
      }
      if (heEngStatusIsStopped(status)) {
        stopped.push({ id: c.campaignId, status });
        done.failed.push({ campaignId: c.campaignId, code: 'needs_attention' });
        await writeHeEngCampaignStatus(portalDb, projectId, c.campaignId, {
          status,
          readError: null,
          startError: 'needs_attention',
          workspace: accountId,
        });
        continue;
      }
      if (via === 'refill' && heEngStatusIsStartable(status)) {
        // Стоит (старт не удался, пауза мимо кабинета) — долив её не стартует.
        done.left += 1;
        await writeHeEngCampaignStatus(portalDb, projectId, c.campaignId, { status, readError: null, workspace: accountId });
        continue;
      }
      if (!heEngStatusIsStartable(status) && !(via === 'refill' && status === CampaignStatus.Completed)) {
        done.failed.push({ campaignId: c.campaignId, code: 'start_failed' });
        await writeHeEngCampaignStatus(portalDb, projectId, c.campaignId, {
          status,
          readError: null,
          startError: 'start_failed',
          workspace: accountId,
        });
        continue;
      }
      // Выключатель и желание клиента — прямо перед стартом (одним заходом):
      // сотрудник мог выключить отправку, клиент — нажать Pause, пока шёл цикл.
      // Окончательное «нельзя» выключателя, Pause или непрочитанное желание —
      // стоп и (шаг 9) пауза уже стартованного этим вызовом; выключатель не
      // прочитался — дальше не стартуем.
      const [accessRead, intentNow] = await Promise.all([
        readHeEngSendingAccess(portalDb, clientUserId),
        readHeEngClientStates(portalDb, [templateId]),
      ]);
      const accessNow = accessRead.state;
      if (!heEngSendingAccessAllows(accessNow)) {
        if (accessNow === 'revoked' || accessNow === 'not_enabled') {
          accessLost = accessNow;
          break;
        }
        accessUnclear = true;
        await fail(c.campaignId, 'read_failed', status, null);
        continue;
      }
      if (intentNow === null || intentNow.get(templateId)?.state === 'paused') {
        intentStop = intentNow === null ? 'unreadable' : 'paused';
        break;
      }
      attemptedIds.push(c.campaignId);
      let after: number | null = null;
      let ambiguous: boolean;
      try {
        const res = await activateCampaign(c.campaignId, { ...options, timeoutMs: ACTION_TIMEOUT_MS });
        after = num(res?.status);
        ambiguous = actionAnswerAmbiguous({ status: after });
      } catch (e) {
        after = null;
        ambiguous = actionAnswerAmbiguous({ threw: e });
      }
      let readBackFailed = false;
      if (!heEngStatusIsSending(after)) {
        const back = await readBack(c.campaignId, accountId, { ambiguous });
        after = back.status;
        readBackFailed = back.status === null;
      }
      if (heEngStatusIsSending(after)) {
        startedIds.push(c.campaignId);
        done.started += 1;
        await writeHeEngCampaignStatus(portalDb, projectId, c.campaignId, {
          status: after,
          readError: null,
          startError: null,
          workspace: accountId,
        });
      } else if (ambiguous && readBackFailed) {
        // Неясный старт и непрочитанное подтверждение: кампания МОГЛА начать
        // отправку — это не «не стартована» ('start_unconfirmed', отдельный
        // счёт, не `failed`). Статус — «не знаем» (null, чтение не удалось):
        // кабинет не покажет её стоящей, сводка предложит Pause, а строка сразу
        // ждёт живого чтения (engCampaignStatus.heEngCampaignsDueForRefresh),
        // которое заменит код на 'start_failed', если она стоит.
        done.unconfirmed += 1;
        await writeHeEngCampaignStatus(portalDb, projectId, c.campaignId, {
          status: null,
          readError: 'failed',
          startError: 'start_unconfirmed',
        });
      } else {
        await fail(c.campaignId, 'start_failed', after ?? status, null);
      }
    }

    // 9. Пока шёл старт, клиент нажал Pause или сотрудник выключил отправку
    //    аккаунта — на паузу каждая кампания, которой этот вызов отправил
    //    POST /activate: подтверждённая и с неясным ответом (неясный старт мог
    //    доехать позже проверочного чтения). Воркспейс проверен чтением этого
    //    вызова. Желание клиента не прочиталось и при повторном чтении —
    //    fail-closed: та же пауза (не знаем, не нажал ли клиент Pause), клиенту
    //    отказ. Выключатель не прочитался после цикла — паузы по нему нет:
    //    каждый старт шёл после удачной проверки выключателя, а выключение, если
    //    оно было, доведёт фоновое чтение статуса.
    let stateUnreadable = intentStop === 'unreadable';
    if (attemptedIds.length > 0) {
      let states = await readHeEngClientStates(portalDb, [templateId]);
      if (states === null) states = await readHeEngClientStates(portalDb, [templateId]);
      // Стоп цикла по желанию клиента держит своё решение: Pause посреди старта
      // не отменяет поздняя запись, непрочитанное желание — fail-closed.
      stateUnreadable = stateUnreadable || states === null;
      const clientPausedNow = intentStop === 'paused' || states?.get(templateId)?.state === 'paused';
      if (!accessLost) {
        const accessAfter = (await readHeEngSendingAccess(portalDb, clientUserId)).state;
        if (accessAfter === 'revoked' || accessAfter === 'not_enabled') accessLost = accessAfter;
      }
      if (clientPausedNow || accessLost || stateUnreadable) {
        const started = new Set(startedIds);
        const notPaused: string[] = [];
        for (const id of attemptedIds) {
          if ((await pauseOne(portalDb, projectId, id, accountId, true)) === 'paused') {
            if (started.has(id)) done.compensated += 1;
          } else {
            notPaused.push(id);
          }
        }
        done.compensationFailed = notPaused.length;
        if (notPaused.length > 0) {
          void notifyHeEngSending(
            accessLost
              ? { kind: 'revoke_pause_failed', projectId, templateId, campaignIds: notPaused, where: 'start' }
              : {
                  kind: 'pause_failed',
                  projectId,
                  templateId,
                  campaignIds: notPaused,
                  // Пауза клиента прочитана из he_eng_launch_sending — её
                  // держат доводка паузы и ночной гейт. Не прочитана — не держит
                  // никто (в таблице, если она жива, — 'sending' этого старта).
                  stateRecorded: clientPausedNow,
                  ...(clientPausedNow ? {} : { cause: 'state_unreadable' as const }),
                },
          );
        }
      }
    }

    if (mismatch.length > 0) {
      void notifyHeEngSending({
        kind: 'mailboxes_mismatch',
        projectId,
        templateId,
        campaignIds: mismatch,
        reason: [...mismatchReasons].join(', '),
      });
    }
    if (stopped.length > 0) {
      void notifyHeEngSending({ kind: 'needs_attention', projectId, templateId, campaigns: stopped });
    }
    void logAudit('he.eng_sending.start', `ENG sending start (${via}): ${done.started} started`, {
      ...ctx,
      campaigns: done.campaigns,
      started: done.started,
      alreadySending: done.alreadySending,
      completed: done.completed,
      failed: done.failed.length,
      failedCodes: [...new Set(done.failed.map((f) => f.code))].join(','),
      notAttempted: done.notAttempted,
      unconfirmed: done.unconfirmed,
      compensated: done.compensated,
      compensationFailed: done.compensationFailed,
      accessLost,
      accessUnclear,
      intentStop,
      stateUnreadable,
    });
    // Отправку аккаунта выключили посреди старта: стартованное этим вызовом
    // поставлено на паузу выше (что не встало — алерт команде), клиенту — тот
    // же отказ, что дал бы выключатель в начале.
    if (accessLost) {
      const refusal = heEngSendingAccessRefusal(accessLost);
      if (refusal) return refused(refusal.status, refusal.code, refusal.message);
    }
    // Желание клиента после цикла не прочиталось — стартованное поставлено на
    // паузу выше; клиенту — отказ (что не встало — алерт команде).
    if (stateUnreadable) {
      return refused(
        503,
        'sending_state_unavailable',
        done.compensationFailed > 0
          ? ENG_START_STATE_UNCONFIRMED_PAUSE_FAILED_TEXT
          : attemptedIds.length > 0
            ? ENG_START_STATE_UNCONFIRMED_TEXT
            : ENG_SENDING_ACCESS_PROBLEM_TEXT,
      );
    }
    // Pause клиента перед первым стартом этого вызова — ничего не стартовано:
    // запуску — как пауза клиента, кнопке — отказ «пауза посреди старта».
    // Стартовал хоть одну — итог с compensated / compensationFailed (шаг 9).
    if (intentStop === 'paused' && attemptedIds.length === 0) {
      if (via === 'launch') return { ...done, clientPaused: true };
      return refused(409, 'client_paused_meanwhile', ENG_START_PAUSED_MEANWHILE_TEXT);
    }
    return done;
  } catch (e) {
    void logWarn('he.eng_sending.start_threw', e instanceof Error ? e.message.slice(0, 300) : 'unknown', ctx);
    return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
  }
}

/* ─────────────── Пауза ─────────────── */

export async function pauseHeEngLaunchSending(input: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  ownerUserId: string;
  projectId: string;
  templateId: string;
  /** 'client' — кнопка Pause (записывает желание клиента); 'staff' — выключение аккаунта. */
  by: 'client' | 'staff';
  /** Только 'staff': где для алерта 'revoke_pause_failed' (по умолчанию — выключение отправки). */
  staffWhere?: 'staff_turn_off' | 'staff_block';
  deadlineMs: number;
  /**
   * Только 'staff_block' (разблокировка, engAccountBlock): кампания, чей не
   * отправляющий статус прочитан у рассыльщика не раньше этого момента
   * (pausedSince), на паузу заново не ставится и засчитывается
   * (`confirmedEarlier`). Не задан — ставится каждая.
   */
  confirmedSinceMs?: number;
  /** Запас на кампанию до срока (по умолчанию PER_CAMPAIGN_BUDGET_MS). */
  campaignReserveMs?: number;
}): Promise<HeEngPauseResult> {
  const { portalDb, instantlyDb, ownerUserId, projectId, templateId, by } = input;
  const ctx = { userId: ownerUserId, projectId, templateId, by };
  // Пауза блокировки и разблокировки: кампанию, до которой кабинет не
  // дотягивается, она не считает неудачей, а называет (`unreachable`).
  const blockPause = by === 'staff' && input.staffWhere === 'staff_block';
  const reserveMs = input.campaignReserveMs ?? PER_CAMPAIGN_BUDGET_MS;
  try {
    const loaded = await loadLaunch(portalDb, {
      ownerUserId,
      projectId,
      templateId,
      columns: 'id, vertical_id, launch_info',
    });
    if (loaded.kind === 'refused') return loaded;
    const campaigns = heEngLaunchCampaigns(loaded.launch);

    // Желание клиента — ДО рассыльщика: доводка паузы и гейт долива читают
    // его, даже если сам вызов рассыльщика не пройдёт. Запись не удалась —
    // один повтор: без неё паузу не держит никто, кроме самого вызова.
    let stateRecorded = false;
    if (by === 'client') {
      stateRecorded = await writeClientState(portalDb, { templateId, state: 'paused', onlyIfAbsent: false });
      if (!stateRecorded) {
        stateRecorded = await writeClientState(portalDb, { templateId, state: 'paused', onlyIfAbsent: false });
      }
    }

    // Воркспейс каждой кампании: тот, в котором она нашлась при удачном живом
    // чтении (строка кэша) — там «404» значит «кампании нет». Не читалась
    // удачно — запасной: пресета записи о запуске, иначе ящиков пула проекта;
    // «404» в запасном — не пауза (кампания может жить в другом воркспейсе).
    // `definite` — ни одно чтение по дороге не упало и записанный воркспейс
    // (если он есть) настроен: только тогда «воркспейса нет» и «404» в
    // запасном значат «кабинету недоступна», а не «не прочли» / «нет ключа».
    const rows = await readHeEngCampaignStatusRows(
      portalDb,
      campaigns.map((c) => c.campaignId),
    );
    let fallback: { accountId: string | null; definite: boolean } | undefined;
    const fallbackWorkspace = async (): Promise<{ accountId: string | null; definite: boolean }> => {
      if (fallback !== undefined) return fallback;
      const workspace = await launchWorkspace(instantlyDb, ownerUserId, loaded.launch.preset_id);
      if (workspace.kind === 'ok') {
        fallback = { accountId: workspace.accountId, definite: true };
      } else {
        const assignment = await readHeSendingPoolAssignment(portalDb, projectId);
        const definite = workspace.kind !== 'error' && assignment.kind !== 'error';
        const poolWorkspace =
          assignment.kind === 'assigned' ? resolveInstantlyAccountId(assignment.instantlyAccountId) : null;
        fallback = {
          accountId: poolWorkspace && heEngWorkspaceConfigured(poolWorkspace) ? poolWorkspace : null,
          definite,
        };
      }
      return fallback;
    };
    const names = blockPause ? launchCampaignNames(loaded.launch) : null;

    const done: HeEngPauseDone = {
      kind: 'done',
      campaigns: campaigns.length,
      paused: 0,
      failed: [],
      notAttempted: 0,
      stateRecorded,
      confirmedEarlier: 0,
      unreachable: [],
    };
    const unattempted: string[] = [];
    let unverifiedWorkspace = 0;
    for (const c of campaigns) {
      const row = rows?.get(c.campaignId);
      if (blockPause && input.confirmedSinceMs !== undefined && pausedSince(row, input.confirmedSinceMs)) {
        done.paused += 1;
        done.confirmedEarlier += 1;
        continue;
      }
      let accountId: string | null = null;
      let trust404 = false;
      let definite = rows !== null;
      const recorded = row?.instantly_account_id ?? null;
      if (recorded && heEngWorkspaceConfigured(recorded)) {
        accountId = resolveInstantlyAccountId(recorded);
        trust404 = true;
      } else if (recorded) {
        // Воркспейс известен, а ключа к нему у процесса нет — это сбой
        // настройки, а не «кабинету недоступна»: такая кампания держит
        // разблокировку (неудача), даже если запасной ответит «404».
        definite = false;
      }
      if (!accountId) {
        const fb = await fallbackWorkspace();
        accountId = fb.accountId;
        definite = definite && fb.definite;
        if (accountId) unverifiedWorkspace += 1;
      }
      const unreachable = (notFoundIn: string | null): HeEngUnreachableCampaign => ({
        campaign_id: c.campaignId,
        name: names?.get(c.campaignId) ?? null,
        workspace: recorded,
        not_found_in: notFoundIn,
      });
      if (!accountId) {
        if (blockPause && definite) done.unreachable.push(unreachable(null));
        else done.failed.push(c.campaignId);
        continue;
      }
      const absentKey = `${c.campaignId}|${accountId}`;
      const absentAt = blockPause && definite && !trust404 ? blockAbsentAt.get(absentKey) : undefined;
      if (absentAt !== undefined && Date.now() - absentAt < HE_ENG_BLOCK_ABSENT_MEMORY_MS) {
        done.unreachable.push(unreachable(accountId));
        continue;
      }
      if (Date.now() + reserveMs > input.deadlineMs) {
        done.notAttempted += 1;
        unattempted.push(c.campaignId);
        continue;
      }
      const paused = await pauseOne(portalDb, projectId, c.campaignId, accountId, trust404);
      if (paused === 'paused') {
        done.paused += 1;
      } else if (paused === 'absent' && blockPause && definite) {
        if (blockAbsentAt.size >= 1000) blockAbsentAt.clear();
        blockAbsentAt.set(absentKey, Date.now());
        done.unreachable.push(unreachable(accountId));
      } else {
        done.failed.push(c.campaignId);
      }
    }
    // Алерт: часть кампаний не встала — или Pause клиента не записался (даже
    // если рассыльщик остановил всё): без записи эту паузу не держат ни доводка
    // при чтении статуса, ни ночной гейт, а кнопка старта и запуск
    // (кроме шага 6b) читают прежнее желание. Недоступные кабинету — в своём
    // алерте блокировки ('campaigns_unreachable', engAccountBlock).
    if (done.failed.length > 0 || unattempted.length > 0 || (by === 'client' && !stateRecorded)) {
      const campaignIds = [...done.failed, ...unattempted];
      void notifyHeEngSending(
        by === 'staff'
          ? { kind: 'revoke_pause_failed', projectId, templateId, campaignIds, where: input.staffWhere ?? 'staff_turn_off' }
          : { kind: 'pause_failed', projectId, templateId, campaignIds, stateRecorded },
      );
    }
    void logAudit('he.eng_sending.pause', `ENG sending pause (${by}): ${done.paused}/${done.campaigns}`, {
      ...ctx,
      campaigns: done.campaigns,
      paused: done.paused,
      failed: done.failed.length,
      notAttempted: done.notAttempted,
      stateRecorded,
      unverifiedWorkspace,
      ...(blockPause ? { confirmedEarlier: done.confirmedEarlier, unreachable: done.unreachable.length } : {}),
    });
    return done;
  } catch (e) {
    void logWarn('he.eng_sending.pause_threw', e instanceof Error ? e.message.slice(0, 300) : 'unknown', ctx);
    return refused(503, 'sending_read_failed', ENG_SENDING_ACCESS_BLIP_TEXT);
  }
}

/** Счётчики паузы кампаний аккаунта (ответ pauseHeEngAccountSending). */
export interface HeEngAccountPauseCounts {
  launches: number;
  /** Не отправляют после вызова (поставлены на паузу, уже стояли или завершены — см. pauseOne). */
  paused: number;
  failed: number;
  notAttempted: number;
  unreadLaunches: number;
  readFailed: boolean;
  /** Только 'staff_block' (поля нет у выключения отправки) — см. HeEngPauseDone. */
  confirmedEarlier?: number;
  unreachable?: HeEngUnreachableCampaign[];
}

/**
 * Ход паузы аккаунта — для вызывающего со своим жёстким сроком
 * (engAccountBlock): функция пишет сюда по мере работы. `listed` — запуски
 * аккаунта прочитаны (`counts.launches` — все); `settledLaunches` — сколько
 * запусков уже дали исход в `counts`. Остальные к сроку вызывающего —
 * запуски без подтверждённой паузы.
 */
export interface HeEngAccountPauseProgress {
  counts: HeEngAccountPauseCounts;
  listed: boolean;
  settledLaunches: number;
}

/**
 * Пауза кампаний ВСЕХ запусков us-проектов аккаунта сотрудником — при
 * выключении отправки (`where` 'staff_turn_off', по умолчанию) и при
 * блокировке клиента ('staff_block', engAccountBlock). Желание клиента не
 * трогается — это решение не его. До срока; что не успели — `notAttempted`.
 * Запуск, чья запись не прочиталась (pauseHeEngLaunchSending отказал до
 * рассыльщика), — `unreadLaunches`, а не кампании: сколько в нём кампаний,
 * неизвестно; по каждому такому шаблону — алерт 'revoke_pause_failed' с тем же
 * `where`. У 'staff_block' — ещё `confirmedEarlier` и `unreachable`
 * (`confirmedSinceMs`, `campaignReserveMs` — см. pauseHeEngLaunchSending).
 * НЕ БРОСАЕТ.
 */
export async function pauseHeEngAccountSending(input: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  userId: string;
  deadlineMs: number;
  where?: 'staff_turn_off' | 'staff_block';
  progress?: HeEngAccountPauseProgress;
  confirmedSinceMs?: number;
  campaignReserveMs?: number;
}): Promise<HeEngAccountPauseCounts> {
  const where = input.where ?? 'staff_turn_off';
  const progress: HeEngAccountPauseProgress = input.progress ?? {
    counts: { launches: 0, paused: 0, failed: 0, notAttempted: 0, unreadLaunches: 0, readFailed: false },
    listed: false,
    settledLaunches: 0,
  };
  const out = progress.counts;
  if (where === 'staff_block') {
    out.confirmedEarlier ??= 0;
    out.unreachable ??= [];
  }
  const readFailed = (): HeEngAccountPauseCounts => {
    out.readFailed = true;
    return { ...out };
  };
  const nothingToPause = (): HeEngAccountPauseCounts => {
    progress.listed = true;
    return { ...out };
  };
  try {
    const { data: projects, error: projErr } = await input.portalDb
      .from('he_projects')
      .select('id')
      .eq('created_by', input.userId)
      .eq('market', 'us');
    if (projErr) return readFailed();
    const projectIds = (projects ?? []).map((p) => String((p as { id?: unknown }).id ?? '')).filter(Boolean);
    if (projectIds.length === 0) return nothingToPause();
    const { data: verticals, error: vertErr } = await input.portalDb
      .from('he_verticals')
      .select('id, project_id')
      .in('project_id', projectIds);
    if (vertErr) return readFailed();
    const projectOf = new Map(
      (verticals ?? []).map((v) => [String((v as { id?: unknown }).id), String((v as { project_id?: unknown }).project_id)]),
    );
    if (projectOf.size === 0) return nothingToPause();
    const { data: templates, error: tplErr } = await input.portalDb
      .from('he_templates')
      .select('id, vertical_id, launch_info')
      .in('vertical_id', [...projectOf.keys()])
      .not('launch_info', 'is', null);
    if (tplErr) return readFailed();
    const launches: Array<{ templateId: string; projectId: string }> = [];
    for (const raw of (templates ?? []) as Array<Record<string, unknown>>) {
      if (!parseLaunchInfo(raw.launch_info)) continue;
      const projectId = projectOf.get(String(raw.vertical_id));
      if (!projectId) continue;
      launches.push({ templateId: String(raw.id), projectId });
    }
    out.launches = launches.length;
    progress.listed = true;
    for (const { templateId, projectId } of launches) {
      const res = await pauseHeEngLaunchSending({
        portalDb: input.portalDb,
        instantlyDb: input.instantlyDb,
        ownerUserId: input.userId,
        projectId,
        templateId,
        by: 'staff',
        staffWhere: where,
        deadlineMs: input.deadlineMs,
        confirmedSinceMs: input.confirmedSinceMs,
        campaignReserveMs: input.campaignReserveMs,
      });
      if (res.kind === 'refused') {
        // Запись запуска не прочиталась — ни одна его кампания не ставилась
        // на паузу; команде — по шаблону, чтобы поставить их руками.
        out.unreadLaunches += 1;
        progress.settledLaunches += 1;
        void notifyHeEngSending({
          kind: 'revoke_pause_failed',
          projectId,
          templateId,
          campaignIds: [],
          where,
          launchUnread: true,
        });
        continue;
      }
      out.paused += res.paused;
      out.failed += res.failed.length;
      out.notAttempted += res.notAttempted;
      if (where === 'staff_block') {
        out.confirmedEarlier = (out.confirmedEarlier ?? 0) + res.confirmedEarlier;
        out.unreachable = [...(out.unreachable ?? []), ...res.unreachable];
      }
      progress.settledLaunches += 1;
    }
    return { ...out };
  } catch {
    return readFailed();
  }
}

/* ─────────────── Сводки для кабинета ─────────────── */

export interface HeEngLaunchRef {
  projectId: string;
  templateId: string;
  launch: HeTemplateLaunchInfo;
}

/**
 * Сводки отправки по запускам клиента (дашборд и шаг 5) из кэша — без
 * ожидания рассыльщика. `refresh` — запустить ФОНОВОЕ живое чтение
 * кампаний, чей статус старше свежести (engCampaignStatus, аренда на все
 * процессы); свежие значения увидит следующий запрос. `readable: false` —
 * статус этого запуска прочитать нечем: его пресет не пресет клиента (запуск
 * сотрудника), его воркспейс не настроен или кэш недоступен. Запуск, созданный
 * до выдачи проекту ящиков пула (heEngLaunchPredatesSelfServe), получает
 * состояние 'pre_self_serve' без кнопки старта — его старт откажет
 * startHeEngLaunchSending тем же признаком. НЕ БРОСАЕТ.
 */
export async function readHeEngSendingSummaries(
  portalDb: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  args: { userId: string; launches: HeEngLaunchRef[]; refresh: boolean; now?: number },
): Promise<Map<string, HeEngSendingSummary>> {
  const out = new Map<string, HeEngSendingSummary>();
  if (args.launches.length === 0) return out;
  const now = args.now ?? Date.now();
  try {
    const access = await readHeEngSendingAccess(portalDb, args.userId);
    const states = await readHeEngClientStates(
      portalDb,
      args.launches.map((l) => l.templateId),
    );
    const perLaunch = args.launches.map((l) => ({ ref: l, campaigns: heEngLaunchCampaigns(l.launch) }));
    const allIds = perLaunch.flatMap((p) => p.campaigns.filter((c) => c.leads > 0).map((c) => c.campaignId));
    const rows = await readHeEngCampaignStatusRows(portalDb, allIds);
    // Когда проектам отданы ящики пула — решает «запуск до self-serve» (кнопки
    // старта нет). Пул не читается — не решаем (старт откажет своей проверкой).
    const assignedSince = await readHeEngPoolAssignedSince(
      portalDb,
      args.launches.map((l) => l.projectId),
    );

    // Воркспейс записи о запуске — пресет самого клиента (один на клиента).
    // Читается, только когда он нужен: есть кампании, которым пора живое
    // чтение, или сводка без статуса (тогда он решает `readable`). На обычном
    // 15-секундном опросе со свежим кэшем — ни одного запроса в БД рассыльщика.
    const needWorkspace =
      rows !== null &&
      perLaunch.some(({ campaigns }) => {
        const ids = campaigns.filter((c) => c.leads > 0).map((c) => c.campaignId);
        return (
          heEngCampaignsDueForRefresh(ids, rows, now).length > 0 || ids.some((id) => rows.get(id)?.status == null)
        );
      });
    const workspaceByPreset = new Map<string, string>();
    let workspacesRead = false;
    if (instantlyDb && needWorkspace) {
      const { data: presets, error } = await instantlyDb
        .from('client_campaign_presets')
        .select('id, instantly_account_id')
        .eq('client_user_id', args.userId);
      if (!error) {
        workspacesRead = true;
        for (const p of (presets ?? []) as Array<{ id?: unknown; instantly_account_id?: unknown }>) {
          const presetWorkspace = resolveInstantlyAccountId(
            typeof p.instantly_account_id === 'string' ? p.instantly_account_id : null,
          );
          // Воркспейс не настроен в окружении — статус этого запуска читать нечем.
          if (heEngWorkspaceConfigured(presetWorkspace)) workspaceByPreset.set(String(p.id), presetWorkspace);
        }
      }
    }

    const view = heEngSendingAccessView(access.state);
    const due = new Map<string, { projectId: string; accountId: string; ids: string[]; templateOf: Map<string, string> }>();
    for (const { ref, campaigns } of perLaunch) {
      const summary = summarizeHeEngSending({
        campaigns,
        rows,
        clientState: states?.get(ref.templateId) ?? null,
        access: view,
        preSelfServe: heEngLaunchPredatesSelfServe(ref.launch, ref.projectId, assignedSince),
        now,
      });
      const accountId = workspaceByPreset.get(ref.launch.preset_id) ?? null;
      // Пресеты не читались (кэш свежий) — статус этого запуска читается, раз
      // он в кэше; прочитаны — читается, только если пресет записи свой.
      out.set(ref.templateId, { ...summary, readable: rows !== null && (!workspacesRead || accountId !== null) });
      if (!args.refresh || rows === null || accountId === null) continue;
      const ids = heEngCampaignsDueForRefresh(
        campaigns.filter((c) => c.leads > 0).map((c) => c.campaignId),
        rows,
        now,
      );
      if (ids.length === 0) continue;
      const key = `${ref.projectId}|${accountId}`;
      const group = due.get(key) ?? {
        projectId: ref.projectId,
        accountId,
        ids: [] as string[],
        templateOf: new Map<string, string>(),
      };
      for (const id of ids) {
        group.ids.push(id);
        group.templateOf.set(id, ref.templateId);
      }
      due.set(key, group);
    }
    for (const group of due.values()) {
      void refreshHeEngCampaignStatuses(portalDb, {
        projectId: group.projectId,
        instantlyAccountId: group.accountId,
        campaignIds: group.ids,
        templateOf: group.templateOf,
      });
    }
    return out;
  } catch (e) {
    warnHeEngSendingDegraded('summaries', `sending summaries threw: ${String(e).slice(0, 200)}`, {});
    return out;
  }
}

/* ─────────────── Кампании ENG — чтобы чужие читатели их не видели ─────────────── */

/**
 * Id кампаний из СРЕЗА записи о запуске (HE_ENG_LAUNCH_CAMPAIGN_COLUMNS): основная
 * (launch_campaign_id) и все из launch_campaigns — те же кампании, что
 * heEngLaunchCampaigns берёт из разобранной записи. Пустые и не-строки
 * пропускаются. Чистая функция.
 */
export function heEngCampaignIdsOfLaunchRow(row: { launch_campaign_id?: unknown; launch_campaigns?: unknown }): string[] {
  const ids = new Set<string>();
  if (typeof row.launch_campaign_id === 'string' && row.launch_campaign_id.trim()) ids.add(row.launch_campaign_id.trim());
  if (Array.isArray(row.launch_campaigns)) {
    for (const c of row.launch_campaigns) {
      const id = c && typeof c === 'object' ? (c as { campaign_id?: unknown }).campaign_id : null;
      if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    }
  }
  return [...ids];
}

/**
 * Срез записи о запуске без поимённого долга (launch_info.pending — тысячи
 * адресов на шаблон): id кампаний, пресет запуска и вертикаль шаблона.
 */
const HE_ENG_LAUNCH_CAMPAIGN_COLUMNS =
  'id, vertical_id, launch_campaign_id:launch_info->>campaign_id, launch_campaigns:launch_info->campaigns, launch_preset_id:launch_info->>preset_id';

const ENG_IDS_PAGE = 1000;
const ENG_IDS_MAX_PAGES = 200;
const ENG_IDS_CHUNK = 100;

type PageAnswer = PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;

/**
 * Все строки выборки страницами по ключу `key` (после последнего ключа
 * страницы, а не смещением) до ПУСТОЙ страницы: короткая страница может быть
 * лимитом строк PostgREST, а не концом (то же правило, что у
 * sendingPool.scanByKeyset). Больше ENG_IDS_PAGE × ENG_IDS_MAX_PAGES строк —
 * ошибка, а не «прочитано частично»: список для исключения обязан быть полным.
 */
async function scanAll(
  label: string,
  key: string,
  page: (after: string | null) => PageAnswer,
  visit: (row: Record<string, unknown>) => void,
): Promise<{ ok: true } | { ok: false; error: string; missing: boolean }> {
  let after: string | null = null;
  for (let n = 0; n < ENG_IDS_MAX_PAGES; n += 1) {
    const { data, error } = await page(after);
    if (error) {
      const code = String(error.code ?? '');
      return { ok: false, error: pgText(`${label} read`, error), missing: code === '42P01' || code === 'PGRST205' };
    }
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    if (rows.length === 0) return { ok: true };
    for (const row of rows) visit(row);
    const last = rows[rows.length - 1]?.[key];
    if (typeof last !== 'string' || !last) return { ok: false, error: `${label}: row without ${key}`, missing: false };
    after = last;
  }
  return { ok: false, error: `${label}: more than ${ENG_IDS_PAGE * ENG_IDS_MAX_PAGES} rows`, missing: false };
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export type HeEngCampaignIdsRead = { ok: true; ids: Set<string> } | { ok: false; error: string };

/**
 * ВСЕ id кампаний ENG-кабинета — для читателей, которые обязаны их НЕ видеть
 * (партнёрский pull-API api/partner/activity: ящики пула ENG лежат в общем
 * воркспейсе рассыльщика, и события ответов на кампании ENG ложатся в ту же
 * ленту instantly_activity_events, что читает партнёр).
 *
 * ЧЬИ КАМПАНИИ (аудит 14.10.2026: только кабинет, а не любой us-проект). Тот
 * же список, по которому ставят на паузу Pause клиента, «Выключить отправку»,
 * блокировка и engBlockedSweep (pauseHeEngAccountSending: проекты рынка 'us'
 * ВЛАДЕЛЬЦА-клиента кабинета, записи о запуске he_templates.launch_info их
 * вертикалей). us-проект, который сотрудник ведёт в staff-инструменте не для
 * клиента кабинета, — не ENG: его кампании могут быть кампаниями партнёра в
 * его же воркспейсе, и вырезать их из его ленты нельзя. Проект — ENG, если:
 *  - владелец (he_projects.created_by) — профиль с market 'eng';
 *  - или профиля владельца НЕТ (created_by без FK: аккаунт удалён, а кампании
 *    его проектов могут жить) — из двух ошибок эта лишь прячет чужие строки,
 *    обратная отдала бы партнёру ответы получателей ENG;
 *  - или проекту отданы ящики пула (he_sending_pool.project_id): письма идут
 *    из ящиков пула, кто бы ни был владельцем.
 * Плюс кампании, запущенные НЕ из такого проекта, но с ПРЕСЕТОМ, по которому
 * запускался ENG-проект (launch_info.preset_id): пресет клиента кабинета —
 * это ящики его пула, и сотрудник, запустивший с ним чужой us-шаблон, шлёт из
 * тех же ящиков. Плюс кэш статусов he_eng_campaign_status (его пишет только
 * отправка кабинета; ключ — проект, и кампания остаётся в нём, даже если
 * запись о запуске пропала вместе с вертикалью).
 *
 * Нет таблицы кэша (миграция 20261011_0002) или пула (20261011_0001) — их
 * часть пуста, остальное читается. Нет колонки profiles.market (42703) —
 * ENG-аккаунтов быть не может, решают пул и кэш. Любой другой сбой —
 * { ok: false }: неполный список исключений — это утечка, вызывающий
 * отказывает. НЕ БРОСАЕТ.
 */
export async function readHeEngCampaignIds(portalDb: SupabaseClient): Promise<HeEngCampaignIdsRead> {
  const ids = new Set<string>();
  try {
    const cache = await scanAll(
      'he_eng_campaign_status',
      'campaign_id',
      (after) => {
        let q = portalDb.from('he_eng_campaign_status').select('campaign_id');
        if (after) q = q.gt('campaign_id', after);
        return q.order('campaign_id', { ascending: true }).limit(ENG_IDS_PAGE);
      },
      (row) => {
        if (typeof row.campaign_id === 'string' && row.campaign_id.trim()) ids.add(row.campaign_id.trim());
      },
    );
    if (!cache.ok && !cache.missing) return { ok: false, error: cache.error };

    // us-проекты и их владельцы.
    const ownerOf = new Map<string, string | null>();
    const projects = await scanAll(
      'he_projects',
      'id',
      (after) => {
        let q = portalDb.from('he_projects').select('id, created_by').eq('market', 'us');
        if (after) q = q.gt('id', after);
        return q.order('id', { ascending: true }).limit(ENG_IDS_PAGE);
      },
      (row) => {
        if (typeof row.id !== 'string' || !row.id) return;
        ownerOf.set(row.id, typeof row.created_by === 'string' && row.created_by ? row.created_by : null);
      },
    );
    if (!projects.ok) return { ok: false, error: projects.error };

    // Профили владельцев: market 'eng' — клиент кабинета; профиля нет — тоже ENG.
    const owners = [...new Set([...ownerOf.values()].filter((v): v is string => v !== null))];
    const foundOwners = new Set<string>();
    const engOwners = new Set<string>();
    let marketColumn = true;
    for (const part of chunks(owners, ENG_IDS_CHUNK)) {
      const { data, error } = await portalDb.from('profiles').select('id, market').in('id', part).limit(part.length);
      if (error) {
        if (String(error.code ?? '') === '42703') {
          marketColumn = false;
          break;
        }
        return { ok: false, error: pgText('profiles read', error) };
      }
      for (const row of (Array.isArray(data) ? data : []) as Array<{ id?: unknown; market?: unknown }>) {
        if (typeof row.id !== 'string') continue;
        foundOwners.add(row.id);
        if (row.market === 'eng') engOwners.add(row.id);
      }
    }
    const engProjects = new Set<string>();
    if (marketColumn) {
      for (const [projectId, owner] of ownerOf) {
        if (owner !== null && (engOwners.has(owner) || !foundOwners.has(owner))) engProjects.add(projectId);
      }
    }

    // Проекты с ящиками пула.
    const pool = await scanAll(
      HE_SENDING_POOL_TABLE,
      'id',
      (after) => {
        let q = portalDb.from(HE_SENDING_POOL_TABLE).select('id, project_id').not('project_id', 'is', null);
        if (after) q = q.gt('id', after);
        return q.order('id', { ascending: true }).limit(ENG_IDS_PAGE);
      },
      (row) => {
        if (typeof row.project_id === 'string' && ownerOf.has(row.project_id)) engProjects.add(row.project_id);
      },
    );
    if (!pool.ok && !pool.missing) return { ok: false, error: pool.error };

    // Вертикали всех us-проектов: запуск не из ENG-проекта нужен ради пресета.
    const projectOfVertical = new Map<string, string>();
    for (const part of chunks([...ownerOf.keys()], ENG_IDS_CHUNK)) {
      const verticals = await scanAll(
        'he_verticals',
        'id',
        (after) => {
          let q = portalDb.from('he_verticals').select('id, project_id').in('project_id', part);
          if (after) q = q.gt('id', after);
          return q.order('id', { ascending: true }).limit(ENG_IDS_PAGE);
        },
        (row) => {
          if (typeof row.id === 'string' && row.id && typeof row.project_id === 'string') {
            projectOfVertical.set(row.id, row.project_id);
          }
        },
      );
      if (!verticals.ok) return { ok: false, error: verticals.error };
    }

    const engPresets = new Set<string>();
    const otherLaunches: Array<{ preset: string; campaigns: string[] }> = [];
    for (const part of chunks([...projectOfVertical.keys()], ENG_IDS_CHUNK)) {
      const templates = await scanAll(
        'he_templates',
        'id',
        (after) => {
          let q = portalDb
            .from('he_templates')
            .select(HE_ENG_LAUNCH_CAMPAIGN_COLUMNS)
            .in('vertical_id', part)
            .not('launch_info', 'is', null);
          if (after) q = q.gt('id', after);
          return q.order('id', { ascending: true }).limit(ENG_IDS_PAGE);
        },
        (row) => {
          const campaigns = heEngCampaignIdsOfLaunchRow(row);
          const preset = typeof row.launch_preset_id === 'string' ? row.launch_preset_id.trim() : '';
          const projectId = typeof row.vertical_id === 'string' ? projectOfVertical.get(row.vertical_id) : undefined;
          if (projectId && engProjects.has(projectId)) {
            for (const id of campaigns) ids.add(id);
            if (preset) engPresets.add(preset);
          } else if (preset && campaigns.length) {
            otherLaunches.push({ preset, campaigns });
          }
        },
      );
      if (!templates.ok) return { ok: false, error: templates.error };
    }
    for (const launch of otherLaunches) {
      if (engPresets.has(launch.preset)) for (const id of launch.campaigns) ids.add(id);
    }
    return { ok: true, ids };
  } catch (e) {
    return { ok: false, error: `ENG campaign ids read threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
}
