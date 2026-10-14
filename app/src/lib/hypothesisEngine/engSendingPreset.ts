/**
 * ENG: пресет отправки клиента — из ящиков пула его проекта.
 *
 * ensureHeEngPresetForProject(projectId, clientUserId) выдаёт проекту ящики из
 * пула (sendingPool.assignHeSendingPool, миграция 20261011_0001) и создаёт или
 * обновляет ЕДИНСТВЕННЫЙ пресет клиента (client_campaign_presets в БД
 * рассыльщика, client_user_id уникален) так, чтобы ядро запуска
 * (runHeTemplateLaunch) создало кампании с этими ящиками в их воркспейсе.
 *
 * КОНТРАКТ ДЛЯ ЛЕЙНА АКТИВАЦИИ (роут запуска ENG-кабинета):
 *  1. Звать ПЕРЕД runHeTemplateLaunch — после requireClientAuth,
 *     requireEngMarket, проверки владельца, requireEngPaidAccess('launch') и
 *     выключателя отправки аккаунта, ДО любой платной работы. Ничего у
 *     рассыльщика функция не делает: только БД (основная и рассыльщика).
 *  2. kind 'ready' → передать ядру presetId (вместо выбранного клиентом
 *     пресета) и scopeClientUserId = клиент. Воркспейс кампаний = воркспейс
 *     пресета = instantlyAccountId ответа; email_list новых кампаний = emails.
 *  3. kind 'shortage' / 'error' → отказать ответом { error: message, code } с
 *     HTTP status из результата; ядро не звать. Фразы английские, «Support»
 *     кабинет рисует ссылкой (EngSupportText). Алерт команде уже отправлен
 *     здесь (shortage, конфликт воркспейса, ящик пула в чужом пресете или в
 *     живом запуске RU-кабинета, пул недоступен, воркспейсы не настроены);
 *     write/read-сбой и «не ENG-клиент /
 *     не его проект» — без алерта: блип («обновите страницу») или отказ по
 *     правам.
 *  4. Перед активацией и Resume проверять живую кампанию против
 *     sendingPool.readHeSendingPoolAssignment (только чтение) и
 *     checkHeCampaignAgainstAssignment: пресет мог поправить администратор
 *     (/admin/clients/[id]/preset), и его синхронизация живых кампаний ENG не
 *     касается.
 *  Повтор безопасен: выдача идемпотентна по проекту, пресет пишется, только
 *  если отличается. Две записи (пул — основная БД, пресет — БД рассыльщика) не
 *  атомарны: сбой между ними оставляет ящики отданными, а пресет прежним, и
 *  следующий вызов доводит пресет. Пресета без ящиков ядро и так не запустит
 *  (409 preset_no_mailboxes).
 *
 * КОМУ. Только профилю role 'client' с market 'eng' и только его us-проекту
 * (created_by = клиент). Сотрудник, которого requireEngMarket пускает в
 * кабинет, получает отказ: его пресет (если есть) — не ENG-клиента, и
 * перезаписывать его ящиками пула нельзя. RU-пресеты (профили не 'eng') этот
 * модуль не пишет никогда.
 *
 * ЧТО ПИШЕТСЯ В ПРЕСЕТ.
 *  - email_account_ids = ВСЕ ящики проекта из пула (адреса, по алфавиту) —
 *    ничего лишнего: решение владельца — письма уходят только из нашего пула;
 *  - instantly_account_id = воркспейс этих ящиков. Сменить его у пресета, по
 *    которому уже были запуски, нельзя (долив appendLeadsToClientCampaign ищет
 *    кампании в воркспейсе пресета) — это держит функция выдачи (шапка
 *    миграции, «закрепление воркспейса»);
 *  - настройки кампаний пула HE_ENG_POOL_CAMPAIGN_SETTINGS (ниже):
 *    stop_on_reply = true, open_tracking = false, link_tracking = false — и у
 *    нового, и у существующего пресета (insert_unsubscribe_header = false
 *    колонки в пресете не имеет и доходит до кампаний через ядро). Кампании
 *    ENG-кабинета получают их и без пресета (ядро, вход campaignSettings; у
 *    staff-роута запуска шаблона us-проекта клиента кабинета ядро берёт их
 *    само — launchTemplate, шаг 4b‴′); в пресете они для путей, которые
 *    строят кампанию только из пресета (запуск us-шаблона не из кабинета
 *    по чужому проекту с этим пресетом). Администратор не может поставить им
 *    другое значение (checkHeEngPresetAdminEdit);
 *  - agency_managed = false: с true RU-запуск кабинета (lib/clientLaunch/
 *    runLaunch.ts) пропустил бы свой тарифный гейт, и ENG-аккаунт отправил бы
 *    из ящиков пула мимо гейтов ENG. Ночной долив ENG тарифный гейт и так
 *    обходит своим entitlementMode 'managed_contract'.
 *  - Только у НОВОГО пресета — окно дефолта кабинета (engDefaultSendingWindow:
 *    09:00–17:00 America/Detroit, пн–пт) вместо московского дефолта колонки.
 *    Кампаниям us-проекта ядро окно пресета не передаёт никогда (всегда окно
 *    кабинета, launchSchedule.ts), поэтому у существующего пресета часы не
 *    трогаются — их видит только экран администратора.
 *  - Дневные лимиты и интервал — дефолты колонок (кампания: 50 писем в день,
 *    50 новых контактов в день, 10 минут между письмами; потолок одного
 *    ящика — его daily_limit у рассыльщика) и не трогаются у существующего
 *    пресета.
 *
 * ПРОВЕРКА ИСКЛЮЧИТЕЛЬНОСТИ ВНЕ ПУЛА (после выдачи, на каждом запуске). Ящик
 * пула, который стоит в пресете ДРУГОГО клиента (администратор вписал руками)
 * или в живом запуске RU-кабинета с выбранными ящиками, слал бы и там, и
 * здесь: отказ 'mailbox_in_other_preset' / 'mailbox_in_other_launch' и алерт.
 * Адреса сравниваются без регистра и пробелов (sendingPool.
 * findHeSendingPoolMailboxUses — там же, что эта проверка видит и чего нет).
 * Ящики, выданные проекту, остаются за ним: отказ повторяется на каждом
 * запуске, пока сотрудник не уберёт адрес оттуда.
 *
 * ПРАВКА ПРЕСЕТА АДМИНИСТРАТОРОМ — checkHeEngPresetAdminEdit ниже (PUT
 * /api/admin/clients/[id]/preset).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { listInstantlyAccounts, resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { engDefaultSendingWindow } from '@/app/api/client/eng/_launchWindow';
import { ENG_PAID_UNAVAILABLE_TEXT } from './engPaidAccess';
import type { HeLaunchCampaignSettings } from './launchTemplate';
import {
  assignHeSendingPool,
  describeHeSendingPoolMailboxUses,
  findHeSendingPoolMailboxUses,
  heSendingPoolAssignableWorkspaces,
  notifyHeSendingPool,
  readHeSendingPoolSize,
  readHeSendingPoolWorkspace,
  HE_SENDING_POOL_TABLE,
  HE_US_POOL_MAILBOXES_PER_PROJECT_ENV,
} from './sendingPool';

/* ─────────────── Настройки кампаний пула ─────────────── */

/**
 * С этими настройками создаётся каждая кампания ENG-кабинета из ящиков пула
 * (engClientLaunch передаёт их ядру входом campaignSettings: основная,
 * сегментная и замена удалённой у рассыльщика кампании, PATCH пустой кампании
 * прошлой попытки), и их же держит пресет клиента (вставка и выравнивание в
 * ensureHeEngPresetForProject, отказ правки в checkHeEngPresetAdminEdit).
 *  - stop_on_reply: цепочка останавливается на ответе.
 *  - open_tracking / link_tracking выключены: ящики пула наши и стоят в
 *    общем воркспейсе с кампаниями RU-клиентов outreachOS (sendingPool.ts,
 *    «Воркспейс пула»), пиксель открытий и переписанные ссылки трекинга
 *    вредят доставляемости, а кабинет показывает только отправленные и
 *    ответы. Решение владельца — подтвердить (отчёт S4, лейн send-settings).
 *  - insert_unsubscribe_header выключен — правило владельца: ни строк
 *    отписки в письмах (letterBrandGuard.heTemplateOptOutLines), ни
 *    заголовка отписки у писем пула. Без явного false заголовок зависел бы от
 *    дефолта воркспейса или ручной правки в рассыльщике. Ядро кладёт
 *    настройки в payload создания и PATCH пустой кампании
 *    (`{ ...presetPayload, ...campaignSettings }`), и ключ доезжает до
 *    рассыльщика и у запуска из кабинета, и у staff-запуска шаблона
 *    us-проекта клиента кабинета (ядро берёт эти настройки само, шаг 4b‴′).
 *    В пресет он не пишется: колонки у client_campaign_presets нет
 *    (PRESET_POOL_SETTING_KEYS). Кампании, созданные до этой правки и уже
 *    принявшие адреса, заголовок не меняют: такая кампания настройки не
 *    получает.
 *  - stop_for_company НЕ задаётся — решение владельца ещё не принято
 *    (отчёт аудита 14.10.2026): ответ одного адреса компании не останавливает
 *    шаги её остальных адресов.
 */
export const HE_ENG_POOL_CAMPAIGN_SETTINGS = {
  stop_on_reply: true,
  open_tracking: false,
  link_tracking: false,
  insert_unsubscribe_header: false,
} as const satisfies Required<HeLaunchCampaignSettings>;

/* ─────────────── Тексты клиенту ─────────────── */

/** Свободных ящиков пула не хватило — ничего не отдано, ничего не отправлено. */
export const ENG_SENDING_SHORTAGE_TEXT =
  'No sending mailboxes are free for your project right now, so campaigns cannot be launched yet. '
  + 'Message Support to get them set up.';

/** Пул недоступен или настройка отправки в конфликте — чинит команда. */
export const ENG_SENDING_SETUP_PROBLEM_TEXT =
  'Campaigns cannot be launched right now because of a problem on our side. Message Support.';

export const ENG_SENDING_PROJECT_NOT_FOUND_TEXT = 'Project not found';

/** Аккаунт не клиент ENG-кабинета (сотрудник, RU-профиль) — пресет пула ему не пишется. */
export const ENG_SENDING_NOT_ELIGIBLE_TEXT =
  'Campaigns can be launched only from the client account that owns this project.';

/** Проект не рынка us — из английского кабинета его кампании не запускаются. */
export const ENG_SENDING_NOT_US_TEXT =
  'Campaigns for this project cannot be launched from this cabinet. Message Support.';

/* ─────────────── Результат ─────────────── */

export type HeEngSendingPresetErrorCode =
  /** 503: пул недоступен, воркспейсы не настроены, конфликт — фраза «проблема у нас, Support». */
  | 'sending_setup_unavailable'
  /** 503: блип чтения или записи — «обновите страницу». */
  | 'sending_setup_failed'
  /** 403 / 404: не ENG-клиент, не его проект, проект не us или его нет. */
  | 'sending_not_available';

/** Внутренняя причина — для журнала и вызывающего, клиенту не показывается. */
export type HeEngSendingPresetErrorReason =
  | 'misconfigured'
  | 'project_not_found'
  | 'not_owner'
  | 'not_us'
  | 'not_eng_client'
  | 'workspaces_unconfigured'
  | 'pool_unavailable'
  | 'workspace_conflict'
  | 'mailbox_in_other_preset'
  | 'mailbox_in_other_launch'
  | 'read_failed'
  | 'write_failed';

export type HeEngSendingPresetResult =
  | {
      kind: 'ready';
      /** id пресета клиента — передать ядру запуска как presetId. */
      presetId: string;
      /** Воркспейс рассыльщика: пресета, ящиков и будущих кампаний. */
      instantlyAccountId: string;
      /** Адреса ящиков проекта (нижний регистр, по алфавиту) = email_account_ids пресета. */
      emails: string[];
      /** Что сделано с пресетом этим вызовом. */
      preset: 'created' | 'updated' | 'unchanged';
      /** Сколько ящиков пула отдано проекту этим вызовом (0 — уже были). */
      newlyAssigned: number;
    }
  | {
      kind: 'shortage';
      status: 409;
      code: 'sending_mailboxes_shortage';
      message: string;
      need: number;
    }
  | {
      kind: 'error';
      status: number;
      code: HeEngSendingPresetErrorCode;
      reason: HeEngSendingPresetErrorReason;
      message: string;
      /** Подробность для журнала (коды БД, воркспейсы) — клиенту не отдавать. */
      detail: string;
    };

export interface HeEngSendingPresetDeps {
  portalDb?: SupabaseClient | null;
  instantlyDb?: SupabaseClient | null;
  env?: NodeJS.ProcessEnv;
}

interface PresetRow {
  id: string;
  instantly_account_id: string | null;
  email_account_ids: unknown;
  stop_on_reply: boolean | null;
  open_tracking: boolean | null;
  link_tracking: boolean | null;
  agency_managed: boolean | null;
}

const PRESET_COLUMNS =
  'id, instantly_account_id, email_account_ids, stop_on_reply, open_tracking, link_tracking, agency_managed';

/**
 * Настройки HE_ENG_POOL_CAMPAIGN_SETTINGS, у которых в пресете есть колонка с
 * тем же именем, — только их пишет пресет. Настройка без колонки (если её
 * добавят в HE_ENG_POOL_CAMPAIGN_SETTINGS) доходит только до кампаний кабинета.
 */
const PRESET_POOL_SETTING_KEYS = ['stop_on_reply', 'open_tracking', 'link_tracking'] as const;

function fail(
  reason: HeEngSendingPresetErrorReason,
  detail: string,
  ctx: { projectId: string; clientUserId: string },
): Extract<HeEngSendingPresetResult, { kind: 'error' }> {
  let status: number;
  let code: HeEngSendingPresetErrorCode;
  let message: string;
  switch (reason) {
    case 'project_not_found':
    case 'not_owner':
      status = 404;
      code = 'sending_not_available';
      message = ENG_SENDING_PROJECT_NOT_FOUND_TEXT;
      break;
    case 'not_us':
      status = 403;
      code = 'sending_not_available';
      message = ENG_SENDING_NOT_US_TEXT;
      break;
    case 'not_eng_client':
      status = 403;
      code = 'sending_not_available';
      message = ENG_SENDING_NOT_ELIGIBLE_TEXT;
      break;
    case 'read_failed':
    case 'write_failed':
      status = 503;
      code = 'sending_setup_failed';
      message = ENG_PAID_UNAVAILABLE_TEXT;
      break;
    default:
      status = 503;
      code = 'sending_setup_unavailable';
      message = ENG_SENDING_SETUP_PROBLEM_TEXT;
  }
  void logWarn('he.eng_sending_preset.refused', `ENG sending preset not ready: ${reason}`, {
    projectId: ctx.projectId,
    userId: ctx.clientUserId,
    reason,
    detail: detail.slice(0, 300),
  });
  return { kind: 'error', status, code, reason, message, detail };
}

function pgDetail(prefix: string, error: { code?: string | null; message?: string | null } | null | undefined): string {
  return `${prefix}: ${error?.code ?? 'error'} ${String(error?.message ?? '').slice(0, 200)}`.trim();
}

/** Адреса пресета для сравнения: строки, обрезанные, в нижнем регистре, без пустых. */
function presetEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()).filter(Boolean))].sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Выдать проекту ящики пула и привести пресет клиента к ним (контракт — шапка
 * файла). Не бросает.
 */
export async function ensureHeEngPresetForProject(
  projectId: string,
  clientUserId: string,
  deps: HeEngSendingPresetDeps = {},
): Promise<HeEngSendingPresetResult> {
  const ctx = { projectId, clientUserId };
  try {
    const portalDb = deps.portalDb === undefined ? supabaseAdmin : deps.portalDb;
    const instantlyDb = deps.instantlyDb === undefined ? supabaseInstantly : deps.instantlyDb;
    const env = deps.env ?? process.env;
    if (!portalDb || !instantlyDb) return fail('misconfigured', 'database client is not configured', ctx);

    // 1. Проект: us и принадлежит клиенту.
    const { data: projectRow, error: projectErr } = await portalDb
      .from('he_projects')
      .select('id, created_by, market')
      .eq('id', projectId)
      .maybeSingle();
    if (projectErr) return fail('read_failed', pgDetail('he_projects read', projectErr), ctx);
    const project = projectRow as { created_by?: unknown; market?: unknown } | null;
    if (!project) return fail('project_not_found', 'no project row', ctx);
    if (project.created_by !== clientUserId) return fail('not_owner', 'project belongs to another account', ctx);
    if (project.market !== 'us') return fail('not_us', `project market ${String(project.market)}`, ctx);

    // 2. Аккаунт: клиент ENG-кабинета (RU-пресеты и пресеты сотрудников не пишем).
    const { data: profileRow, error: profileErr } = await portalDb
      .from('profiles')
      .select('role, market')
      .eq('id', clientUserId)
      .maybeSingle();
    // 42703 — колонки market нет: рынок неизвестен, это не ENG-клиент.
    if (profileErr && profileErr.code !== '42703') return fail('read_failed', pgDetail('profiles read', profileErr), ctx);
    const profile = (profileErr ? null : profileRow) as { role?: unknown; market?: unknown } | null;
    if (!profile || profile.role !== 'client' || profile.market !== 'eng') {
      return fail('not_eng_client', `role ${String(profile?.role ?? 'none')}, market ${String(profile?.market ?? 'none')}`, ctx);
    }

    // 3. Сколько ящиков и из каких воркспейсов: настроенные, кроме 'main' — ящиков
    //    пула в main не бывает (sendingPool.ts, «Воркспейс пула»). Воркспейс пула
    //    (HE_US_POOL_WORKSPACE) выдачу не ограничивает — он нужен алертам: куда
    //    добавлять ящики или почему некуда.
    const size = readHeSendingPoolSize(env);
    if (size.rejected) {
      void logWarn('he.eng_sending_preset.size_rejected', `unreadable ${HE_US_POOL_MAILBOXES_PER_PROJECT_ENV} — default used`, {
        projectId,
        count: size.count,
      });
    }
    let configured: string[] | null = null;
    let workspaces: string[] = [];
    let workspacesProblem: string | null = null;
    try {
      configured = listInstantlyAccounts().map((a) => a.id);
      workspaces = heSendingPoolAssignableWorkspaces(configured);
      if (configured.length === 0) workspacesProblem = 'no sending workspace is configured';
      else if (workspaces.length === 0) workspacesProblem = 'only the main workspace is configured, and the ENG pool never uses main';
    } catch (e) {
      workspacesProblem = `INSTANTLY_ACCOUNTS_JSON: ${e instanceof Error ? e.message : 'unreadable'}`;
    }
    const poolWorkspace = readHeSendingPoolWorkspace(configured, env);
    if (workspacesProblem) {
      void notifyHeSendingPool({ kind: 'unavailable', projectId, cause: 'workspaces', reason: workspacesProblem });
      return fail('workspaces_unconfigured', workspacesProblem, ctx);
    }

    // 4. Текущий пресет клиента — его воркспейс закрепляет выдачу, если запуски уже были.
    const readPreset = () =>
      instantlyDb
        .from('client_campaign_presets')
        .select(PRESET_COLUMNS)
        .eq('client_user_id', clientUserId)
        .maybeSingle();
    const { data: presetData, error: presetErr } = await readPreset();
    if (presetErr) return fail('read_failed', pgDetail('client_campaign_presets read', presetErr), ctx);
    let preset = (presetData ?? null) as PresetRow | null;
    const presetWorkspace = preset ? resolveInstantlyAccountId(preset.instantly_account_id) : null;

    // 5. Ящики проекта из пула.
    const assigned = await assignHeSendingPool(portalDb, {
      projectId,
      count: size.count,
      workspaces,
      presetWorkspace,
    });
    switch (assigned.kind) {
      case 'assigned':
        break;
      case 'shortage':
        void notifyHeSendingPool({
          kind: 'shortage',
          projectId,
          need: assigned.need,
          bestFree: assigned.bestFree,
          pinnedWorkspace: assigned.pinnedWorkspace,
          byWorkspace: assigned.byWorkspace,
          poolWorkspace,
        });
        void logWarn('he.eng_sending_preset.shortage', 'ENG sending pool shortage: launch refused', {
          projectId,
          userId: clientUserId,
          need: assigned.need,
          bestFree: assigned.bestFree,
          pinnedWorkspace: assigned.pinnedWorkspace,
          poolWorkspace: poolWorkspace.id,
          poolWorkspaceProblem: poolWorkspace.ok ? null : poolWorkspace.problem,
        });
        return {
          kind: 'shortage',
          status: 409,
          code: 'sending_mailboxes_shortage',
          message: ENG_SENDING_SHORTAGE_TEXT,
          need: assigned.need,
        };
      case 'workspace_conflict': {
        const detail =
          `${assigned.reason}; pool workspace ${assigned.instantlyAccountId ?? '—'}; ` +
          `preset workspace ${assigned.presetWorkspace ?? presetWorkspace ?? 'none'}` +
          (assigned.reason === 'unconfigured'
            ? `; выдача берёт ящики только из ${workspaces.join(', ')} (main — никогда)`
            : '');
        void notifyHeSendingPool({ kind: 'conflict', projectId, reason: assigned.reason, detail });
        return fail('workspace_conflict', detail, ctx);
      }
      case 'not_found':
        return fail('project_not_found', 'project disappeared before assignment', ctx);
      case 'not_us':
        return fail('not_us', 'project market changed before assignment', ctx);
      case 'unavailable':
        void notifyHeSendingPool({
          kind: 'unavailable',
          projectId,
          cause: 'pool_missing',
          reason: 'he_sending_pool / he_sending_pool_assign missing',
        });
        return fail('pool_unavailable', 'migration 20261011_0001 not applied', ctx);
      case 'error':
        return fail('read_failed', assigned.message, ctx);
    }

    const ws = assigned.instantlyAccountId;
    const emails = [...new Set(assigned.mailboxes.map((m) => m.email.trim().toLowerCase()))].sort();
    if (assigned.newlyAssigned > 0) {
      void logAudit('he.eng_sending_preset.mailboxes_assigned', 'ENG sending pool mailboxes assigned to project', {
        projectId,
        userId: clientUserId,
        instantlyAccountId: ws,
        mailboxes: assigned.newlyAssigned,
        freeLeft: assigned.freeLeft,
      });
      if (assigned.freeLeft !== null && assigned.freeLeft < size.count) {
        void notifyHeSendingPool({
          kind: 'low',
          projectId,
          instantlyAccountId: ws,
          freeLeft: assigned.freeLeft,
          perProject: size.count,
          poolWorkspace,
        });
      }
    }

    // 6. Ящик пула не стоит ни в пресете ДРУГОГО клиента, ни в живом запуске
    //    RU-кабинета (без регистра и пробелов — шапка файла).
    const uses = await findHeSendingPoolMailboxUses(instantlyDb, emails, { exceptPresetOfClient: clientUserId });
    if (uses.kind === 'error') return fail('read_failed', uses.message, ctx);
    if (uses.kind === 'in_use') {
      const reason = uses.uses.some((u) => u.source === 'preset') ? 'mailbox_in_other_preset' : 'mailbox_in_other_launch';
      const detail = `ящик пула уже используется: ${describeHeSendingPoolMailboxUses(uses.uses)}`;
      void notifyHeSendingPool({ kind: 'conflict', projectId, reason, detail });
      return fail(reason, detail, ctx);
    }

    // 7. Пресет клиента. Нового нет — вставка; гонка двух вставок (два запуска
    //    подряд) — вторая получает 23505, перечитывает и идёт обновлением.
    let presetOutcome: 'created' | 'updated' | 'unchanged' = 'unchanged';
    if (!preset) {
      const window = engDefaultSendingWindow();
      const { data: inserted, error: insertErr } = await instantlyDb
        .from('client_campaign_presets')
        .insert({
          client_user_id: clientUserId,
          instantly_account_id: ws,
          email_account_ids: emails,
          stop_on_reply: HE_ENG_POOL_CAMPAIGN_SETTINGS.stop_on_reply,
          open_tracking: HE_ENG_POOL_CAMPAIGN_SETTINGS.open_tracking,
          link_tracking: HE_ENG_POOL_CAMPAIGN_SETTINGS.link_tracking,
          agency_managed: false,
          schedule_from: window.from,
          schedule_to: window.to,
          schedule_days: window.days,
          schedule_timezone: window.timezone,
        })
        .select(PRESET_COLUMNS)
        .single();
      if (insertErr && insertErr.code !== '23505') {
        return fail('write_failed', pgDetail('client_campaign_presets insert', insertErr), ctx);
      }
      if (insertErr) {
        const { data: again, error: againErr } = await readPreset();
        if (againErr || !again) {
          return fail('read_failed', pgDetail('client_campaign_presets re-read', againErr ?? { message: 'no row after 23505' }), ctx);
        }
        preset = again as PresetRow;
      } else {
        preset = inserted as PresetRow;
        presetOutcome = 'created';
      }
    }

    if (presetOutcome !== 'created') {
      const patch: Record<string, unknown> = {};
      if (resolveInstantlyAccountId(preset.instantly_account_id) !== ws) patch.instantly_account_id = ws;
      if (!sameList(presetEmails(preset.email_account_ids), emails)) patch.email_account_ids = emails;
      for (const key of PRESET_POOL_SETTING_KEYS) {
        if (preset[key] !== HE_ENG_POOL_CAMPAIGN_SETTINGS[key]) patch[key] = HE_ENG_POOL_CAMPAIGN_SETTINGS[key];
      }
      if (preset.agency_managed !== false) patch.agency_managed = false;
      if (Object.keys(patch).length > 0) {
        const { data: updated, error: updateErr } = await instantlyDb
          .from('client_campaign_presets')
          .update(patch)
          .eq('id', preset.id)
          .eq('client_user_id', clientUserId)
          .select('id')
          .maybeSingle();
        if (updateErr) return fail('write_failed', pgDetail('client_campaign_presets update', updateErr), ctx);
        if (!updated) return fail('write_failed', 'preset row disappeared before update', ctx);
        presetOutcome = 'updated';
      }
    }

    if (presetOutcome !== 'unchanged') {
      void logAudit('he.eng_sending_preset.written', `ENG sending preset ${presetOutcome} from the pool`, {
        projectId,
        userId: clientUserId,
        presetId: preset.id,
        instantlyAccountId: ws,
        mailboxes: emails.length,
        previousWorkspace: presetWorkspace,
      });
    }

    return {
      kind: 'ready',
      presetId: preset.id,
      instantlyAccountId: ws,
      emails,
      preset: presetOutcome,
      newlyAssigned: assigned.newlyAssigned,
    };
  } catch (e) {
    return fail('read_failed', `threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`, ctx);
  }
}

/* ─────────────── Правка пресета ENG-клиента администратором ─────────────── */

export type HeEngPresetAdminEditCheck = { ok: true } | { ok: false; status: number; message: string };

/** Тексты сотруднику (экран /admin/clients/[id]/preset показывает поле error ответа). */
export const ENG_PRESET_ADMIN_CREATE_REFUSED_TEXT =
  'Это клиент ENG-кабинета: его пресет создаётся сам при первом запуске — из ящиков «Пул ящиков ENG», выданных его проекту. Создавать пресет здесь нельзя.';
export const ENG_PRESET_ADMIN_WORKSPACE_REFUSED_TEXT =
  'Это клиент ENG-кабинета: воркспейс его пресета — воркспейс его ящиков из «Пул ящиков ENG» (там его кампании, и ночной долив ищет их там). Сменить воркспейс здесь нельзя.';
export const ENG_PRESET_ADMIN_STOP_ON_REPLY_REFUSED_TEXT =
  'Это клиент ENG-кабинета: «Останавливать цепочку при ответе» в его пресете всегда включено (его ставит запуск из пула). Выключить здесь нельзя.';
export const ENG_PRESET_ADMIN_TRACKING_REFUSED_TEXT =
  'Это клиент ENG-кабинета: «Отслеживать открытия писем» и «Отслеживать клики по ссылкам» в его пресете ставит запуск из пула — с этими значениями создаются все его кампании. Изменить здесь нельзя.';
export const ENG_PRESET_ADMIN_READ_FAILED_TEXT =
  'Не удалось прочитать пресет клиента ENG-кабинета — ничего не сохранено, попробуйте ещё раз.';

/**
 * Пресет НЕ клиента ENG-кабинета (RU, VE2, сотрудник): в нём не может стоять
 * ящик, отданный проекту ENG-кабинета (he_sending_pool, status 'assigned').
 * Текст сотруднику — по-русски, адреса названы.
 */
export function engPoolMailboxInOtherPresetText(emails: string[]): string {
  return (
    'Ящики уже отданы проекту английского кабинета («Пул ящиков ENG») и отправляют его письма: ' +
    `${emails.slice(0, 5).join(', ')}${emails.length > 5 ? ` и ещё ${emails.length - 5}` : ''}. ` +
    'В пресет другого клиента их ставить нельзя — оба клиента слали бы из одного ящика. Ничего не сохранено. ' +
    'Снимите галочки с этих ящиков и сохраните ещё раз.'
  );
}

/**
 * Проверка пресета НЕ клиента ENG-кабинета (аудит 14.10.2026): ящики пула
 * лежат в общем воркспейсе рассыльщика, и экран пресета показывает их как
 * обычные ящики воркспейса. Пул сам проверяет чужие пресеты, когда ящик
 * отдаётся проекту, включается или стартует кампания
 * (sendingPool.findHeSendingPoolMailboxUses), но ящик, УЖЕ отданный проекту,
 * без этой проверки мог тихо попасть в пресет RU- или VE2-клиента — и два
 * клиента слали бы из одного ящика.
 *
 * Правило: в списке ящиков, который сохраняет администратор, есть адрес со
 * статусом 'assigned' в he_sending_pool — отказ 409 с адресами, ничего не
 * записано. Сравнение — без регистра и пробелов (пул хранит нижний регистр).
 * Свободные ('available') и выключенные ящики пула не проверяются: их
 * проверит выдача проекту. Правка без списка ящиков — как раньше.
 *
 * Сбой чтения пула — { ok: true } и warn (как у сбоя чтения профиля выше):
 * RU-путь из-за нашего чтения не отказывает, а двойное использование всё
 * равно ловит ENG-сторона — старт, запуск и ночной долив отказывают с алертом,
 * пока ящик стоит в чужом пресете. Нет таблицы пула (миграция 20261011_0001
 * не применена) — ящиков пула нет, проверять нечего. Не бросает.
 */
async function refuseAssignedPoolMailboxes(
  portalDb: SupabaseClient,
  clientUserId: string,
  change: Record<string, unknown>,
): Promise<HeEngPresetAdminEditCheck> {
  if (change.email_account_ids === undefined) return { ok: true };
  const wanted = presetEmails(change.email_account_ids);
  if (wanted.length === 0) return { ok: true };
  try {
    const { data, error } = await portalDb
      .from(HE_SENDING_POOL_TABLE)
      .select('email')
      .eq('status', 'assigned')
      .in('email', wanted)
      .limit(wanted.length);
    if (error) {
      const code = String((error as { code?: unknown }).code ?? '');
      if (code !== '42P01' && code !== 'PGRST205') {
        void logWarn('he.eng_preset_admin_edit.pool_unchecked', 'he_sending_pool unreadable — pool mailbox guard of a non-ENG preset skipped', {
          targetUserId: clientUserId,
          detail: pgDetail('he_sending_pool read', error),
        });
      }
      return { ok: true };
    }
    const taken = presetEmails((Array.isArray(data) ? data : []).map((r) => (r as { email?: unknown }).email));
    if (taken.length === 0) return { ok: true };
    void logAudit('he.eng_preset_admin_edit.refused', 'pool mailbox assigned to an ENG project put into another client preset — refused', {
      targetUserId: clientUserId,
      fields: Object.keys(change),
      reason: 'pool_mailbox_assigned',
      mailboxes: taken,
    });
    return { ok: false, status: 409, message: engPoolMailboxInOtherPresetText(taken) };
  } catch (e) {
    void logWarn('he.eng_preset_admin_edit.pool_unchecked', 'pool mailbox guard of a non-ENG preset threw — skipped', {
      targetUserId: clientUserId,
      detail: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
    });
    return { ok: true };
  }
}

function engPresetAddRefusedText(added: string[]): string {
  return (
    'Это клиент ENG-кабинета: ящики его пресета — только ящики «Пул ящиков ENG», выданные его проекту ' +
    '(запуск кладёт их сам). Добавить ящик здесь нельзя, снимать галочки можно. ' +
    `Новые адреса: ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` и ещё ${added.length - 5}` : ''}.`
  );
}

/**
 * PUT /api/admin/clients/[id]/preset для клиента ENG-кабинета. Его пресет
 * ведёт пул: ensureHeEngPresetForProject пишет пресет только профилю role
 * 'client' + market 'eng' (шаг 2), поэтому «пресет пула» узнаётся по профилю.
 * Маркера в самом пресете нет: agency_managed занят RU-смыслом (с ним
 * RU-запуск кабинета пропускает тарифный гейт), другой колонки под маркер в
 * БД рассыльщика нет.
 *
 * ENG-клиенту администратор НЕ может (409, ничего не записано):
 *  - создать пресет — его создаёт первый запуск из пула;
 *  - добавить адрес, которого в пресете нет (сравнение без регистра и
 *    пробелов) — письма уходят только из ящиков пула проекта;
 *  - сменить воркспейс — запущенный клиент закреплён за воркспейсом пресета
 *    (долив appendLeadsToClientCampaign ищет кампании там);
 *  - выключить stop_on_reply;
 *  - поставить open_tracking / link_tracking не то значение, что в
 *    HE_ENG_POOL_CAMPAIGN_SETTINGS, если в пресете сейчас другое (пресет,
 *    записанный до этих настроек, сохраняется как есть — его выровняет
 *    следующий запуск).
 * Может: убрать адреса (runbook смены сайта, шаг 5.0, когда кнопка «Вернуть
 * ящики в пул» не очистила пресет; адрес, который ещё отдан проекту,
 * следующий запуск вернёт сам) и менять остальные поля. Синхронизация
 * пресета администратора ENG-кампаний не касается (журнал запусков RU их не
 * содержит).
 *
 * RU и остальные профили — после чтения профиля одна проверка: в списке ящиков
 * нет ящика, отданного проекту ENG-кабинета (refuseAssignedPoolMailboxes —
 * иначе 409 с адресами); правка без списка ящиков и сбой чтения пула —
 * { ok: true }, дальше PUT идёт как раньше. Профиль не прочитался или чтение бросило (кроме 42703
 * — нет колонки market: такой профиль не ENG) — тоже { ok: true } и warn:
 * решение «ENG или нет» без профиля не принять, а отказ здесь менял бы и
 * RU-путь. В этом состоянии пресет ENG-клиента не защищён; адреса всё равно
 * перепишет следующий запуск, смену воркспейса запущенного клиента он
 * откажет (workspace_conflict + алерт), а старт кампании проверяет её ящики
 * против пула (checkHeCampaignAgainstAssignment). Когда профиль ENG уже
 * известен, сбой чтения пресета — отказ 503.
 * Не бросает.
 */
export async function checkHeEngPresetAdminEdit(
  clientUserId: string,
  change: Record<string, unknown>,
  deps: Pick<HeEngSendingPresetDeps, 'portalDb' | 'instantlyDb'> = {},
): Promise<HeEngPresetAdminEditCheck> {
  let engClient = false;
  try {
    const portalDb = deps.portalDb === undefined ? supabaseAdmin : deps.portalDb;
    const instantlyDb = deps.instantlyDb === undefined ? supabaseInstantly : deps.instantlyDb;
    if (!portalDb) {
      void logWarn('he.eng_preset_admin_edit.unchecked', 'main DB client is not configured — ENG preset guard skipped', {
        targetUserId: clientUserId,
      });
      return { ok: true };
    }

    const { data: profileRow, error: profileErr } = await portalDb
      .from('profiles')
      .select('role, market')
      .eq('id', clientUserId)
      .maybeSingle();
    if (profileErr && profileErr.code !== '42703') {
      void logWarn('he.eng_preset_admin_edit.unchecked', 'profile unreadable — ENG preset guard skipped', {
        targetUserId: clientUserId,
        detail: pgDetail('profiles read', profileErr),
      });
      return { ok: true };
    }
    const profile = (profileErr ? null : profileRow) as { role?: unknown; market?: unknown } | null;
    if (!profile || profile.role !== 'client' || profile.market !== 'eng') {
      return await refuseAssignedPoolMailboxes(portalDb, clientUserId, change);
    }

    // Клиент ENG-кабинета: всё ниже — только его путь, сбой здесь — отказ.
    engClient = true;
    if (!instantlyDb) return { ok: false, status: 503, message: ENG_PRESET_ADMIN_READ_FAILED_TEXT };
    const { data: currentRow, error: currentErr } = await instantlyDb
      .from('client_campaign_presets')
      .select('instantly_account_id, email_account_ids, open_tracking, link_tracking')
      .eq('client_user_id', clientUserId)
      .maybeSingle();
    if (currentErr) {
      void logWarn('he.eng_preset_admin_edit.read_failed', 'ENG preset unreadable — admin edit refused', {
        targetUserId: clientUserId,
        detail: pgDetail('client_campaign_presets read', currentErr),
      });
      return { ok: false, status: 503, message: ENG_PRESET_ADMIN_READ_FAILED_TEXT };
    }
    const current = currentRow as {
      instantly_account_id: string | null;
      email_account_ids: unknown;
      open_tracking: boolean | null;
      link_tracking: boolean | null;
    } | null;

    let refused: {
      reason: 'create' | 'workspace' | 'add_mailbox' | 'stop_on_reply' | 'tracking';
      message: string;
    } | null = null;
    if (!current) {
      refused = { reason: 'create', message: ENG_PRESET_ADMIN_CREATE_REFUSED_TEXT };
    } else if (
      change.instantly_account_id !== undefined &&
      resolveInstantlyAccountId(String(change.instantly_account_id)) !== resolveInstantlyAccountId(current.instantly_account_id)
    ) {
      refused = { reason: 'workspace', message: ENG_PRESET_ADMIN_WORKSPACE_REFUSED_TEXT };
    } else if (change.email_account_ids !== undefined) {
      const have = new Set(presetEmails(current.email_account_ids));
      const added = presetEmails(change.email_account_ids).filter((e) => !have.has(e));
      if (added.length > 0) refused = { reason: 'add_mailbox', message: engPresetAddRefusedText(added) };
    }
    if (!refused && change.stop_on_reply !== undefined && change.stop_on_reply !== true) {
      refused = { reason: 'stop_on_reply', message: ENG_PRESET_ADMIN_STOP_ON_REPLY_REFUSED_TEXT };
    }
    if (!refused && current) {
      const awayFromPool = (['open_tracking', 'link_tracking'] as const).some(
        (key) => change[key] !== undefined && change[key] !== HE_ENG_POOL_CAMPAIGN_SETTINGS[key] && change[key] !== current[key],
      );
      if (awayFromPool) refused = { reason: 'tracking', message: ENG_PRESET_ADMIN_TRACKING_REFUSED_TEXT };
    }
    if (refused) {
      void logAudit('he.eng_preset_admin_edit.refused', 'admin edit of an ENG client preset refused', {
        targetUserId: clientUserId,
        fields: Object.keys(change),
        reason: refused.reason,
      });
      return { ok: false, status: 409, message: refused.message };
    }
    return { ok: true };
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 200) : 'unknown';
    if (engClient) {
      void logWarn('he.eng_preset_admin_edit.read_failed', 'ENG preset guard threw — admin edit refused', {
        targetUserId: clientUserId,
        detail,
      });
      return { ok: false, status: 503, message: ENG_PRESET_ADMIN_READ_FAILED_TEXT };
    }
    void logWarn('he.eng_preset_admin_edit.unchecked', 'ENG preset guard threw before the profile was known — skipped', {
      targetUserId: clientUserId,
      detail,
    });
    return { ok: true };
  }
}
