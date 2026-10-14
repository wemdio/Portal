import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { listInstantlyAccounts, resolveInstantlyAccountId, type PublicInstantlyAccount } from '@/lib/instantly/accounts';
import {
  checkHeSendingPoolMailboxAtProvider,
  describeHeSendingPoolMailboxUses,
  findHeSendingPoolMailboxUses,
  heSendingPoolAssignableWorkspaces,
  normalizeHeSendingPoolEmail,
  readHeSendingPoolSize,
  readHeSendingPoolWorkspace,
  HE_SENDING_POOL_FORBIDDEN_WORKSPACE,
  HE_SENDING_POOL_TABLE,
  HE_US_POOL_WORKSPACE_ENV,
  type HeSendingPoolStatus,
} from '@/lib/hypothesisEngine/sendingPool';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Нет таблицы пула: миграция 20261011_0001 не применена. */
function isPoolMissing(code: string | null | undefined): boolean {
  return code === '42P01' || code === 'PGRST205';
}

const MIGRATION_MISSING_TEXT = 'Пул ящиков ENG недоступен: не применена миграция 20261011_0001_he_sending_pool.sql';

const NOTES_MAX = 500;
const LIST_LIMIT = 2000;

/**
 * Пул НАШИХ ящиков отправки ENG (решение владельца 10–11.10.2026: клиент ящики
 * не подключает, каждый us-проект получает из пула свои — шапка миграции
 * 20261011_0001 и lib/hypothesisEngine/sendingPool.ts).
 *
 * GET — весь пул (до LIST_LIMIT строк) с проектом у отданных, сводка по
 * воркспейсам, сколько ящиков получает новый проект, какие воркспейсы
 * настроены, воркспейс пула (pool_workspace: куда экран добавляет ящики, или
 * почему некуда) и из каких воркспейсов выдача берёт ящики
 * (assignable_workspaces — все настроенные, кроме main). Таблицы нет —
 * { supported: false } (экран пишет «миграция не применена», а не «пул пуст»).
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.sending-pool.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      let workspaces: PublicInstantlyAccount[] = [];
      let workspacesError: string | null = null;
      try {
        workspaces = listInstantlyAccounts();
      } catch (e) {
        workspacesError = e instanceof Error ? e.message : 'INSTANTLY_ACCOUNTS_JSON не читается';
      }
      const size = readHeSendingPoolSize();
      const configured = workspacesError ? null : workspaces.map((w) => w.id);
      const pool = readHeSendingPoolWorkspace(configured);
      const poolWorkspace = {
        id: pool.id,
        ok: pool.ok,
        from_env: pool.fromEnv,
        problem: pool.ok ? null : pool.problem,
      };
      const assignableWorkspaces = configured ? heSendingPoolAssignableWorkspaces(configured) : [];

      const { data, error } = await supabaseAdmin
        .from(HE_SENDING_POOL_TABLE)
        .select(
          'id, email, instantly_account_id, status, project_id, assigned_at, released_at, notes, created_at, ' +
            'project:he_projects(id, name, website_url)',
        )
        .order('created_at', { ascending: true })
        .limit(LIST_LIMIT);
      if (error) {
        if (isPoolMissing(error.code)) {
          return NextResponse.json({
            supported: false,
            per_project: size.count,
            per_project_rejected: size.rejected,
            workspaces,
            workspaces_error: workspacesError,
            pool_workspace: poolWorkspace,
            assignable_workspaces: assignableWorkspaces,
            rows: [],
            counts: {},
          });
        }
        await logError('tools.hypothesis-engine.sending-pool.list_failed', error, { userId: authed.auth.userId });
        return jsonError('Не удалось прочитать пул ящиков', 500);
      }

      const rows = (Array.isArray(data) ? data : []) as unknown as Array<{ instantly_account_id: string; status: HeSendingPoolStatus }>;
      const counts: Record<string, Record<HeSendingPoolStatus, number>> = {};
      for (const row of rows) {
        const bucket = (counts[row.instantly_account_id] ??= { available: 0, assigned: 0, disabled: 0 });
        if (row.status in bucket) bucket[row.status] += 1;
      }

      return NextResponse.json({
        supported: true,
        per_project: size.count,
        per_project_rejected: size.rejected,
        workspaces,
        workspaces_error: workspacesError,
        pool_workspace: poolWorkspace,
        assignable_workspaces: assignableWorkspaces,
        rows,
        truncated: rows.length >= LIST_LIMIT,
        counts,
      });
    },
  );
}

/**
 * POST — добавить ОДИН ящик в пул свободным. Тело: { email, instantly_account_id,
 * notes? }. Экран добавляет список по одному запросу на адрес — так у каждой
 * строки свой ответ, а запрос укладывается в maxDuration (одна проверка у
 * рассыльщика).
 *
 * Проверки по порядку (первая не прошедшая — отказ, ничего не записано):
 *  1. адрес похож на адрес; воркспейс не main (пул ENG живёт во втором
 *     аккаунте рассыльщика — sendingPool.ts, «Воркспейс пула»), настроен в
 *     окружении и это воркспейс пула (HE_US_POOL_WORKSPACE, по умолчанию
 *     account-2); воркспейс пула не годится — отказ с причиной;
 *  2. адреса ещё нет в пуле (в любом статусе);
 *  3. адреса нет ни в одном пресете клиента и ни в одном живом запуске
 *     RU-кабинета с выбранными ящиками (findHeSendingPoolMailboxUses: без
 *     регистра и пробелов; там же — чего эта проверка не видит): ящик,
 *     который уже шлёт за RU- или любого другого клиента, в пул не берём —
 *     иначе он слал бы за двоих;
 *  4. у рассыльщика ящик есть в ЭТОМ воркспейсе, активен, настроен и прогрев
 *     не в плохом статусе (checkHeSendingPoolMailboxAtProvider — один GET).
 * Гонка двух добавлений одного адреса — уникальность email в таблице (409).
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.sending-pool.add' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

      let body: Record<string, unknown>;
      try {
        const parsed = (await req.json()) as unknown;
        body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        return jsonError('Тело запроса — JSON-объект', 400);
      }

      const email = normalizeHeSendingPoolEmail(body.email);
      if (!email) return jsonError('Неверный адрес ящика', 400);

      if (typeof body.instantly_account_id !== 'string' || !body.instantly_account_id.trim()) {
        return jsonError('Укажите воркспейс рассыльщика', 400);
      }
      const instantlyAccountId = resolveInstantlyAccountId(body.instantly_account_id);
      if (instantlyAccountId === HE_SENDING_POOL_FORBIDDEN_WORKSPACE) {
        return jsonError(
          'В воркспейс «main» ящики пула не добавляются: пул ENG живёт во втором аккаунте рассыльщика ' +
            '(там, где клиенты RU-кабинета outreachOS)',
          400,
        );
      }
      let configured: string[];
      try {
        configured = listInstantlyAccounts().map((a) => a.id);
      } catch (e) {
        await logError('tools.hypothesis-engine.sending-pool.accounts_unreadable', e, { userId });
        return jsonError('Воркспейсы рассыльщика не читаются из окружения (INSTANTLY_ACCOUNTS_JSON)', 500);
      }
      if (!configured.includes(instantlyAccountId)) {
        return jsonError(`Воркспейс «${instantlyAccountId}» не настроен в окружении`, 400);
      }
      const pool = readHeSendingPoolWorkspace(configured);
      if (!pool.ok) {
        return jsonError(`Воркспейс пула не настроен — ${pool.problem}. Ящик не добавлен`, 409);
      }
      if (instantlyAccountId !== pool.id) {
        return jsonError(
          `Ящики в пул добавляются только в воркспейс пула «${pool.id}» (${HE_US_POOL_WORKSPACE_ENV}), ` +
            `а не в «${instantlyAccountId}»`,
          400,
        );
      }

      let notes: string | null = null;
      if (body.notes !== undefined && body.notes !== null) {
        if (typeof body.notes !== 'string') return jsonError('Заметка — строка', 400);
        notes = body.notes.trim().slice(0, NOTES_MAX) || null;
      }

      // 2. Уже в пуле.
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from(HE_SENDING_POOL_TABLE)
        .select('id, status, instantly_account_id')
        .eq('email', email)
        .maybeSingle();
      if (existingErr) {
        if (isPoolMissing(existingErr.code)) return jsonError(MIGRATION_MISSING_TEXT, 409);
        await logError('tools.hypothesis-engine.sending-pool.read_failed', existingErr, { userId });
        return jsonError('Не удалось прочитать пул ящиков', 500);
      }
      if (existing) {
        const row = existing as { status?: unknown; instantly_account_id?: unknown };
        return jsonError(
          `Ящик уже в пуле (воркспейс ${String(row.instantly_account_id)}, статус ${String(row.status)})`,
          409,
        );
      }

      // 3. Уже в пресете клиента или в живом запуске RU-кабинета (без регистра).
      const uses = await findHeSendingPoolMailboxUses(supabaseInstantly, [email]);
      if (uses.kind === 'error') {
        await logError('tools.hypothesis-engine.sending-pool.presets_read_failed', new Error(uses.message), { userId });
        return jsonError('Не удалось проверить пресеты и запуски клиентов — ящик не добавлен, попробуйте ещё раз', 500);
      }
      if (uses.kind === 'in_use') {
        return jsonError(
          `Ящик уже используется другим клиентом: ${describeHeSendingPoolMailboxUses(uses.uses)} — в пул его брать нельзя`,
          409,
        );
      }

      // 4. У рассыльщика.
      const provider = await checkHeSendingPoolMailboxAtProvider(email, instantlyAccountId);
      if (!provider.ok) return jsonError(provider.message, provider.status);

      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from(HE_SENDING_POOL_TABLE)
        .insert({ email, instantly_account_id: instantlyAccountId, notes })
        .select('id, email, instantly_account_id, status, project_id, assigned_at, released_at, notes, created_at')
        .single();
      if (insertErr) {
        if (insertErr.code === '23505') return jsonError('Ящик уже в пуле', 409);
        if (isPoolMissing(insertErr.code)) return jsonError(MIGRATION_MISSING_TEXT, 409);
        await logError('tools.hypothesis-engine.sending-pool.insert_failed', insertErr, { userId });
        return jsonError('Не удалось добавить ящик в пул', 500);
      }

      void logAudit('tools.hypothesis-engine.sending_pool_added', 'ENG sending pool mailbox added', {
        userId,
        email,
        instantlyAccountId,
      });
      return NextResponse.json({ ok: true, row: inserted });
    },
  );
}
