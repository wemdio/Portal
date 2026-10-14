/**
 * Выключатель отправки ENG-аккаунта (engSendingAccess.ts; решение владельца
 * 10–11.10.2026: пока нет оплаты, отправку нового аккаунта один раз включает
 * сотрудник). Экран — карточка клиента в разделе «Английские клиенты»
 * (/admin/eng-clients/[id]): «Включить отправку» / «Выключить отправку» /
 * «Выключить ещё раз / доставить паузу».
 *
 * GET  — состояние: applicable (ENG-клиент), required (требование не снято
 *        HE_US_SENDING_REQUIRES_ACTIVATION), state ('enabled' | 'not_enabled' |
 *        'revoked' | 'unavailable' | 'error'), когда клиент упёрся
 *        (requested_at), когда включили / выключили, ушло ли письмо; плюс то,
 *        что карточка клиента пишет рядом с «Включить отправку»: включён ли
 *        автозапуск (auto_launch — выключатель HE_ENG_AUTO_LAUNCH) и хватит ли
 *        пула ящиков на этого клиента (pool — readAccountPoolRoom).
 * POST { enabled: boolean }
 *   - включить: ЗАБЛОКИРОВАННОМУ клиенту — отказ 409 (активная отметка
 *     блокировки he_eng_account_blocks или бан входа в будущем): блокировка
 *     держит отправку выключенной, пока клиента не разблокируют. Отметка или
 *     бан не прочитались — 503, ничего не меняется. Иначе строка
 *     enabled=true — и больше ничего: разблокировка уже выключила автопилот,
 *     автозапуск и «Daily top-up» и поставила кампании на паузу, прежде чем
 *     снять бан (engAccountBlock), а снова их запускает только клиент. Затем
 *     письмо клиенту «Sending is on» (engSendingAccessMail); не ушло — ответ
 *     так и говорит (написать клиенту руками). Текст письма выбирается по
 *     состоянию аккаунта, прочитанному прямо перед отправкой
 *     (sendingEnabledCopy ниже);
 *   - выключить: строка enabled=false + revoked_at, затем ПАУЗА кампаний всех
 *     запусков us-проектов аккаунта (engCampaignSending.pauseHeEngAccountSending,
 *     срок ACTION_BUDGET_MS; что не встало — алерт 'revoke_pause_failed' и
 *     счётчики в ответе); запуск и старт выключенного аккаунта отказываются
 *     гейтом (engSendingAccess; старт, идущий в этот момент, перечитывает
 *     выключатель перед каждой кампанией и ставит стартованное на паузу),
 *     ночной долив — тоже ('access_turned_off' в createHeRefillSendGate,
 *     autoPipeline.ts). Выключение действует и при снятом требовании
 *     (HE_US_SENDING_REQUIRES_ACTIVATION=0): строку выключателя гейты читают
 *     всегда.
 *   Повтор включения ничего не меняет (ни письма). Повтор выключения строку не
 *   трогает, но паузу кампаний делает снова (экран: «Выключить ещё раз /
 *   доставить паузу»). Выключение не отказывается никогда (и заблокированному).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isValidUuid } from '@/lib/apiValidation';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  heEngSendingActivationRequired,
  readHeEngSendingAccess,
  setHeEngSendingAccess,
  type HeEngSendingAccess,
} from '@/lib/hypothesisEngine/engSendingAccess';
import { sendHeEngSendingEnabledEmail } from '@/lib/hypothesisEngine/engSendingAccessMail';
import { pauseHeEngAccountSending } from '@/lib/hypothesisEngine/engCampaignSending';
import { readHeEngAccountBlock, readHeEngAccountBlockRows } from '@/lib/hypothesisEngine/engAccountBlockMarker';
import { readHeEngAccountResearch } from '@/lib/hypothesisEngine/engAccountBlock';
import { HE_ENG_LAUNCH_INTENT_TABLE, heEngAutoLaunchEnabled } from '@/lib/hypothesisEngine/engAutoLaunch';
import { toClientEngRefillState } from '@/lib/hypothesisEngine/clientEngProjection';
import {
  HE_SENDING_POOL_TABLE,
  heSendingPoolAssignableWorkspaces,
  readHeSendingPoolSize,
} from '@/lib/hypothesisEngine/sendingPool';
import { listInstantlyAccounts } from '@/lib/instantly/accounts';
import type { EngSendingEnabledCopy, EngSendingEnabledFacts } from '@/lib/email/templates/engSendingEnabled';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ACTION_BUDGET_MS = 45_000;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Заблокирован ли клиент (для отказа во включении): активная отметка
 * блокировки ИЛИ бан входа в будущем (бан мимо раздела «Английские клиенты»
 * отметки не пишет). Нет таблицы отметок — решает бан. Сбой любого чтения —
 * 'unknown' (включать нельзя).
 */
async function engAccountBlockedNow(db: NonNullable<typeof supabaseAdmin>, userId: string): Promise<'blocked' | 'clear' | 'unknown'> {
  const [marker, auth] = await Promise.all([
    readHeEngAccountBlock(db, userId),
    db.auth.admin.getUserById(userId).catch(() => null),
  ]);
  if (marker.state === 'blocked') return 'blocked';
  const user = auth && !auth.error ? (auth.data?.user ?? null) : null;
  const bannedUntil = typeof user?.banned_until === 'string' ? user.banned_until.trim() : '';
  if (bannedUntil) {
    // Непарсящийся срок бана — считаем баном (как readHeEngAccountStanding).
    const until = Date.parse(bannedUntil);
    if (!Number.isFinite(until) || until > Date.now()) return 'blocked';
  }
  if (marker.state === 'error' || !user) return 'unknown';
  return 'clear';
}

function isTableMissing(error: { code?: string | null } | null | undefined): boolean {
  const code = error?.code ?? '';
  return code === '42P01' || code === 'PGRST205';
}

/** Сколько свободных строк пула читаем: нужно лишь «хватит ли на несколько проектов» — нижней оценки хватает. */
const POOL_FREE_READ_LIMIT = 1000;

/**
 * Пул ящиков глазами одного аккаунта — то же правило, что у выдачи
 * (he_sending_pool_assign, миграция 20261011_0001; зовёт её
 * engSendingPreset.ensureHeEngPresetForProject при запуске):
 *  - проект, у которого уже есть отданные ящики ('assigned'), получает их же —
 *    пул ему не нужен (assignedProjects);
 *  - проекту без ящиков нужно perProject (HE_US_POOL_MAILBOXES_PER_PROJECT,
 *    дефолт 3) свободных в ОДНОМ воркспейсе выдачи — все настроенные, кроме
 *    main (heSendingPoolAssignableWorkspaces);
 *  - сколько проектов без ящиков пул примет (fitsNew) — как «хватит на N
 *    новых клиентов» полосы пула раздела (engAdminView.readPoolStrip): сумма по
 *    воркспейсам выдачи floor(свободно / perProject). Свободных читается не
 *    больше POOL_FREE_READ_LIMIT — fitsNew тогда нижняя оценка.
 * Закрепление воркспейса пресетом клиента (у него уже был запуск) здесь не
 * учитывается: с одним сайтом на аккаунт второй проект без ящиков — редкость.
 * Воркспейсы рассыльщика не читаются из окружения — 'error' (выдача при этом
 * тоже откажет: workspaces_unconfigured). Нет таблицы пула — 'missing'.
 * НЕ БРОСАЕТ.
 */
type AccountPoolRoom =
  | { state: 'ok'; perProject: number; fitsNew: number; assignedProjects: Set<string>; assignedMailboxes: number }
  | { state: 'missing' }
  | { state: 'error' };

async function readAccountPoolRoom(
  db: NonNullable<typeof supabaseAdmin>,
  projectIds: readonly string[],
): Promise<AccountPoolRoom> {
  try {
    let assignable: Set<string>;
    try {
      const configured = listInstantlyAccounts().map((a) => a.id);
      assignable = new Set(heSendingPoolAssignableWorkspaces(configured));
    } catch {
      return { state: 'error' };
    }
    if (assignable.size === 0) return { state: 'error' };
    const perProject = readHeSendingPoolSize().count;
    const [freeRes, assignedRes] = await Promise.all([
      db.from(HE_SENDING_POOL_TABLE).select('instantly_account_id').eq('status', 'available').limit(POOL_FREE_READ_LIMIT),
      projectIds.length > 0
        ? db
            .from(HE_SENDING_POOL_TABLE)
            .select('project_id')
            .eq('status', 'assigned')
            .in('project_id', [...projectIds])
            .limit(1000)
        : Promise.resolve({ data: [] as Array<{ project_id?: unknown }>, error: null }),
    ]);
    if (freeRes.error || assignedRes.error) {
      return isTableMissing(freeRes.error) || isTableMissing(assignedRes.error) ? { state: 'missing' } : { state: 'error' };
    }
    const freeByWorkspace = new Map<string, number>();
    for (const r of (freeRes.data ?? []) as Array<{ instantly_account_id?: unknown }>) {
      const ws = typeof r.instantly_account_id === 'string' ? r.instantly_account_id : '';
      if (ws && assignable.has(ws)) freeByWorkspace.set(ws, (freeByWorkspace.get(ws) ?? 0) + 1);
    }
    let fitsNew = 0;
    for (const free of freeByWorkspace.values()) fitsNew += Math.floor(free / perProject);
    const assignedRows = (assignedRes.data ?? []) as Array<{ project_id?: unknown }>;
    const assignedProjects = new Set(
      assignedRows.map((r) => (typeof r.project_id === 'string' ? r.project_id : '')).filter(Boolean),
    );
    return { state: 'ok', perProject, fitsNew, assignedProjects, assignedMailboxes: assignedRows.length };
  } catch {
    return { state: 'error' };
  }
}

/**
 * Обслужит ли пул проекты аккаунта прямо сейчас: каждый проект из `needing`
 * без своих ящиков получит perProject свободных (fitsNew), а если проектов
 * для запуска нет (`needing` пуст) — хоть одному проекту аккаунта ящики уже
 * отданы или пул примет новый. null — пул не прочитан (ни «да», ни «нет»).
 */
function poolServes(room: AccountPoolRoom, needing: readonly string[]): boolean | null {
  if (room.state !== 'ok') return null;
  if (needing.length === 0) return room.assignedProjects.size > 0 || room.fitsNew >= 1;
  const without = needing.filter((id) => !room.assignedProjects.has(id)).length;
  return without === 0 || room.fitsNew >= without;
}

/**
 * Какой текст письма «Sending is on» (что обещает каждый — шапка шаблона
 * engSendingEnabled.ts) — по состоянию аккаунта, прочитанному прямо перед
 * отправкой. `revokedAt` — последнее выключение отправки (после включения его
 * не стирают); `enabledBefore` — отправку уже включали раньше (enabled_at,
 * прочитанный до этой записи).
 *  - «первое включение после разблокировки»: строка отметки снята
 *    (active=false), и после снятия отправку не выключали (revoked_at не
 *    позже unblocked_at; разблокировка выключает её до снятия);
 *  - «автозапуск включён»: хоть у одного us-проекта аккаунта
 *    he_eng_launch_intent.wanted = true.
 * После разблокировки без автозапуска — 'unblocked' («turned sending back
 * on»; отправку ни разу не включали — 'launch_needed');
 * без автозапуска и без разблокировки — 'launch_needed'; с автозапуском —
 * 'auto', но после разблокировки — 'check'. Ни один проект не 'researched'
 * (шага 3 с «Launch» нет) — вместо 'unblocked' / 'launch_needed' — 'research'
 * (проектов нет вовсе — 'check': «создайте проект»).
 * Факты письма (`facts`) — только прочитанное здесь: проекты и кто снова
 * запустит исследование каждого не исследованного (вердикт шага 1 —
 * engAccountBlock.readHeEngAccountResearch: «Try again» там, где шаг 1 его
 * показывает, команда — где нет), было ли у проекта «Launch» хоть раз (строка
 * автозапуска), есть ли запуски (he_templates.launch_info) и «Daily top-up»
 * каждого проекта — так, как его показывает дашборд (toClientEngRefillState).
 * Не прочиталось что-то — 'check' без фактов (текст, верный при любом
 * состоянии). Нет таблицы отметок — разблокировок не было; нет таблицы
 * автозапуска — 'auto' (его текст честен и без неё: «если рынок показывает
 * «Launch now», нажмите»), после разблокировки — 'check'; нет таблицы добора
 * — добора нет.
 *
 * ОБЕЩАНИЕ СТАРТА «САМ» ('auto') — только когда оно сбудется:
 *  - выключатель HE_ENG_AUTO_LAUNCH выключен (heEngAutoLaunchEnabled; тот же
 *    env_file у портала и воркера) — тик ничего не берёт: вместо 'auto' —
 *    'check' (с фактами); 'launch_needed' и 'unblocked' («press «Launch» to
 *    turn it on») тоже 'check' — «Launch» автозапуск сейчас не включит;
 *  - пул ящиков не обслужит проекты с автозапуском (readAccountPoolRoom,
 *    poolServes: у проекта нет своих ящиков, а свободных на него не хватает)
 *    или не прочитался — вместо 'auto' 'check'. Пул не обслужит аккаунт —
 *    факт mailboxesShort: текст говорит, что ящиков для его кампаний ещё нет
 *    (как ENG_SENDING_SHORTAGE_TEXT кабинета), и ничего не обещает.
 * Поведение «Launch» (платная подготовка) это не меняет — только текст.
 * Второе возвращаемое поле — короткий итог для ответа сотруднику.
 * НЕ БРОСАЕТ.
 */
async function sendingEnabledCopy(
  db: NonNullable<typeof supabaseAdmin>,
  userId: string,
  revokedAt: string | null,
  enabledBefore: boolean,
): Promise<{ copy: EngSendingEnabledCopy; mailboxesShort: boolean }> {
  const autoSwitchOn = heEngAutoLaunchEnabled();
  const plain = (copy: EngSendingEnabledCopy) => ({ copy, mailboxesShort: false });
  try {
    const rows = await readHeEngAccountBlockRows(db, [userId]);
    if (rows.state === 'error') return plain('check');
    const row = rows.state === 'ok' ? (rows.rows.get(userId) ?? null) : null;
    // Непарсящиеся даты — сравнение ложно: считаем, что выключения после
    // разблокировки не было.
    const afterUnblock =
      row !== null && !row.active && (revokedAt === null || !(Date.parse(revokedAt) > Date.parse(row.unblockedAt ?? '')));

    const research = await readHeEngAccountResearch(db, userId);
    if (!research.ok) return plain('check');
    const list = research.projects;
    const ids = list.map((p) => p.id);
    const wantedIds: string[] = [];
    let anyWanted = false;
    let anyIntent = false;
    let intentMissing = false;
    let launched = false;
    let poolRoom: AccountPoolRoom = { state: 'error' };
    const topUp: NonNullable<EngSendingEnabledFacts['topUp']> = { on: 0, held: 0, off: 0 };
    if (ids.length > 0) {
      const readConfigs = (columns: string) =>
        db.from('he_auto_pipeline_configs').select(columns).in('project_id', ids).limit(1000);
      const [{ data: intents, error: intentErr }, first, { data: verticals, error: verticalsErr }, pool] = await Promise.all([
        db.from(HE_ENG_LAUNCH_INTENT_TABLE).select('project_id, wanted').in('project_id', ids).limit(1000),
        readConfigs('project_id, enabled, refill_paused_at, refill_pause_reason'),
        db.from('he_verticals').select('id').in('project_id', ids).limit(1000),
        readAccountPoolRoom(db, ids),
      ]);
      poolRoom = pool;
      // Колонок паузы нет (миграция 20260930_0005) — паузы нет и у ночи: только enabled.
      const { data: configs, error: configsErr } =
        first.error?.code === '42703' ? await readConfigs('project_id, enabled') : first;
      if (intentErr) {
        if (!isTableMissing(intentErr)) return plain('check');
        intentMissing = true;
      }
      const intentRows = (intents ?? []) as Array<{ project_id?: unknown; wanted?: unknown }>;
      anyIntent = intentRows.length > 0;
      for (const i of intentRows) {
        if (i.wanted === true && typeof i.project_id === 'string') wantedIds.push(i.project_id);
      }
      anyWanted = intentRows.some((i) => i.wanted === true);
      if (configsErr) {
        if (!isTableMissing(configsErr)) return plain('check');
      } else {
        for (const cfg of (configs ?? []) as unknown as Array<Record<string, unknown>>) {
          const state = toClientEngRefillState(cfg);
          if (state === 'running') topUp.on += 1;
          else if (state === 'paused' || state === 'spend_paused') topUp.held += 1;
          else topUp.off += 1;
        }
      }
      // Запуски — шаблоны рынков проекта с записью о запуске (как у паузы кампаний аккаунта).
      if (verticalsErr) return plain('check');
      const verticalIds = ((verticals ?? []) as Array<{ id?: unknown }>)
        .map((v) => (typeof v.id === 'string' ? v.id : ''))
        .filter(Boolean);
      if (verticalIds.length > 0) {
        const { data: templates, error: templatesErr } = await db
          .from('he_templates')
          .select('id')
          .in('vertical_id', verticalIds)
          .not('launch_info', 'is', null)
          .limit(1);
        if (templatesErr) return plain('check');
        launched = (templates ?? []).length > 0;
      }
    } else {
      poolRoom = await readAccountPoolRoom(db, ids);
    }
    // Пул: обслужит ли он проекты, которые запускаются сами (намерение
    // wanted), а без них — хоть один проект аккаунта. null — не прочитан.
    const serves = poolServes(poolRoom, anyWanted ? wantedIds : []);
    const mailboxesShort = serves === false;
    // 'auto' — только при включённом автозапуске и пуле, который обслужит.
    const autoTrue = autoSwitchOn && serves === true;
    if (intentMissing) return plain(afterUnblock || !autoTrue ? 'check' : 'auto');
    const restarts: EngSendingEnabledFacts['research'] = { tryAgain: 0, teamFix: 0, team: 0, running: 0 };
    for (const p of list) {
      if (p.restart === 'try_again') restarts.tryAgain += 1;
      else if (p.restart === 'team_fix') restarts.teamFix += 1;
      else if (p.restart === 'team') restarts.team += 1;
      else if (p.restart === 'running') restarts.running += 1;
    }
    const facts: EngSendingEnabledFacts = {
      projects: list.length,
      launchable: list.some((p) => p.status === 'researched'),
      launchPressed: anyIntent,
      launched,
      research: restarts,
      topUp,
      ...(mailboxesShort ? { mailboxesShort: true } : {}),
    };
    // Отправку ни разу не включали: «turned sending back on» было бы неправдой
    // — текст 'launch_needed' (про кампании, созданные раньше, он говорит
    // «does not change campaigns created before»).
    const kind = afterUnblock ? (anyWanted ? 'check' : enabledBefore ? 'unblocked' : 'launch_needed') : anyWanted ? 'auto' : 'launch_needed';
    if (kind === 'auto') return autoTrue ? plain('auto') : { copy: { kind: 'check', facts }, mailboxesShort };
    if ((kind === 'unblocked' || kind === 'launch_needed') && !facts.launchable) {
      // Проектов нет — 'check' с фактами («создайте проект»).
      return { copy: { kind: facts.projects === 0 ? 'check' : 'research', facts }, mailboxesShort };
    }
    // «Press «Launch» to turn it on» — неправда, пока выключатель автозапуска выключен.
    if (!autoSwitchOn && (kind === 'unblocked' || kind === 'launch_needed')) {
      return { copy: { kind: 'check', facts }, mailboxesShort };
    }
    return { copy: { kind, facts }, mailboxesShort };
  } catch {
    return plain('check');
  }
}

function view(access: HeEngSendingAccess) {
  return {
    applicable: access.state !== 'not_client',
    required: heEngSendingActivationRequired(),
    state: access.state === 'not_client' || access.state === 'not_required' ? 'not_enabled' : access.state,
    requested_at: access.requestedAt,
    enabled_at: access.enabledAt,
    revoked_at: access.revokedAt,
    email_sent_at: access.emailSentAt,
  };
}

/**
 * Пул для карточки клиента (строка рядом с «Включить отправку»): ящики, уже
 * отданные us-проектам клиента, и сколько новых проектов примет пул (то же
 * «хватит на N новых клиентов», что у полосы пула раздела). Не прочиталось —
 * state 'missing' / 'error', карточка тогда молчит.
 */
async function poolView(db: NonNullable<typeof supabaseAdmin>, userId: string) {
  try {
    const { data, error } = await db.from('he_projects').select('id').eq('created_by', userId).eq('market', 'us').limit(1000);
    if (error) return { state: 'error' as const };
    const ids = ((data ?? []) as Array<{ id?: unknown }>)
      .map((p) => (typeof p.id === 'string' ? p.id : ''))
      .filter(Boolean);
    const room = await readAccountPoolRoom(db, ids);
    if (room.state !== 'ok') return { state: room.state };
    return {
      state: 'ok' as const,
      per_project: room.perProject,
      fits_new_clients: room.fitsNew,
      client_mailboxes: room.assignedMailboxes,
      client_projects: ids.length,
      client_projects_with_mailboxes: room.assignedProjects.size,
    };
  } catch {
    return { state: 'error' as const };
  }
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { id } = await ctx.params;
  if (!isValidUuid(id)) return jsonError('Некорректный id', 400);
  const [access, pool] = await Promise.all([
    readHeEngSendingAccess(supabaseAdmin, id, { skipEnv: true }),
    poolView(supabaseAdmin, id),
  ]);
  return NextResponse.json({ ...view(access), auto_launch: heEngAutoLaunchEnabled(), pool });
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { id } = await ctx.params;
  if (!isValidUuid(id)) return jsonError('Некорректный id', 400);

  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') return jsonError('Поле enabled должно быть boolean', 400);
  const enabled = body.enabled;

  // Включали ли отправку раньше — до записи, которая перепишет enabled_at (текст письма).
  let enabledBefore = false;
  if (enabled) {
    const standing = await engAccountBlockedNow(supabaseAdmin, id);
    if (standing === 'blocked') return jsonError('Клиент заблокирован — сначала разблокируйте.', 409);
    if (standing === 'unknown') {
      return jsonError('Не удалось проверить блокировку клиента — попробуйте ещё раз.', 503);
    }
    enabledBefore = (await readHeEngSendingAccess(supabaseAdmin, id, { skipEnv: true })).enabledAt !== null;
  }

  const set = await setHeEngSendingAccess(supabaseAdmin, id, enabled);
  if (set.kind === 'not_eng_client') return jsonError('Это не клиент английского кабинета', 400);
  if (set.kind === 'unavailable') {
    return jsonError('Таблица выключателя не создана — примените миграцию 20261011_0002_he_eng_sending.sql', 409);
  }
  if (set.kind === 'error') {
    await logError('admin.users.eng_sending.failed', new Error(set.message), { targetUserId: id, enabled }, {
      userId: auth.auth.user.id,
    });
    return jsonError('Не удалось изменить отправку аккаунта', 500);
  }

  let email: 'sent' | 'no_email' | 'failed' | null = null;
  let emailCopy: EngSendingEnabledCopy | null = null;
  let emailMailboxesShort = false;
  let paused: Awaited<ReturnType<typeof pauseHeEngAccountSending>> | null = null;
  if (set.changed && enabled) {
    if (set.row.email) {
      const picked = await sendingEnabledCopy(supabaseAdmin, id, set.row.revokedAt, enabledBefore);
      emailCopy = picked.copy;
      emailMailboxesShort = picked.mailboxesShort;
    }
    const sent = await sendHeEngSendingEnabledEmail(supabaseAdmin, id, set.row.email, emailCopy ?? undefined);
    email = sent.kind;
    if (sent.kind === 'failed') {
      await logError('admin.users.eng_sending.email_failed', new Error(sent.message), { targetUserId: id }, {
        userId: auth.auth.user.id,
      });
    }
  }
  // Пауза кампаний — при КАЖДОМ выключении, после которого аккаунт выключен
  // ('revoked'), а не только при смене: повтор «Выключить» (экран — «Выключить
  // ещё раз / доставить паузу») доставляет паузу кампаниям, которые не встали
  // с первого раза.
  if (!enabled && (set.changed || set.row.state === 'revoked')) {
    if (supabaseInstantly) {
      paused = await pauseHeEngAccountSending({
        portalDb: supabaseAdmin,
        instantlyDb: supabaseInstantly,
        userId: id,
        deadlineMs: Date.now() + ACTION_BUDGET_MS,
      });
    } else {
      paused = { launches: 0, paused: 0, failed: 0, notAttempted: 0, unreadLaunches: 0, readFailed: true };
    }
  }

  await logAudit(
    enabled ? 'admin.users.eng_sending.enabled' : 'admin.users.eng_sending.revoked',
    enabled ? 'ENG account sending enabled by staff' : 'ENG account sending turned off by staff',
    { targetUserId: id, changed: set.changed, email, emailCopy, paused },
    { userId: auth.auth.user.id },
  );

  const after = await readHeEngSendingAccess(supabaseAdmin, id, { skipEnv: true });
  return NextResponse.json({
    ok: true,
    changed: set.changed,
    email,
    // Какой текст ушёл и сказал ли он, что ящиков для кампаний клиента ещё нет (пул).
    email_copy: emailCopy === null ? null : typeof emailCopy === 'string' ? emailCopy : emailCopy.kind,
    email_mailboxes_short: email === 'sent' ? emailMailboxesShort : null,
    paused,
    ...view(after),
  });
}
