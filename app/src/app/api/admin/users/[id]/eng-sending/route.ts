/**
 * Выключатель отправки ENG-аккаунта (engSendingAccess.ts; решение владельца
 * 10–11.10.2026: пока нет оплаты, отправку нового аккаунта один раз включает
 * сотрудник). Экран — модалка пользователя в /admin/users, рядом с «Пресет
 * запуска кампаний» и блокировкой.
 *
 * GET  — состояние: applicable (ENG-клиент), required (требование не снято
 *        HE_US_SENDING_REQUIRES_ACTIVATION), state ('enabled' | 'not_enabled' |
 *        'revoked' | 'unavailable' | 'error'), когда клиент упёрся
 *        (requested_at), когда включили / выключили, ушло ли письмо.
 * POST { enabled: boolean }
 *   - включить: строка enabled=true, затем письмо клиенту «Sending is on»
 *     (engSendingAccessMail); не ушло — ответ так и говорит (написать клиенту
 *     руками);
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
 *   доставить паузу»).
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

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ACTION_BUDGET_MS = 45_000;

type RouteContext = { params: Promise<{ id: string }> };

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

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { id } = await ctx.params;
  if (!isValidUuid(id)) return jsonError('Некорректный id', 400);
  const access = await readHeEngSendingAccess(supabaseAdmin, id, { skipEnv: true });
  return NextResponse.json(view(access));
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
  let paused: Awaited<ReturnType<typeof pauseHeEngAccountSending>> | null = null;
  if (set.changed && enabled) {
    const sent = await sendHeEngSendingEnabledEmail(supabaseAdmin, id, set.row.email);
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
    { targetUserId: id, changed: set.changed, email, paused },
    { userId: auth.auth.user.id },
  );

  const after = await readHeEngSendingAccess(supabaseAdmin, id, { skipEnv: true });
  return NextResponse.json({ ok: true, changed: set.changed, email, paused, ...view(after) });
}
