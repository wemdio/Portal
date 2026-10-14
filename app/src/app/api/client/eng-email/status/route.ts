import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logWarn } from '@/lib/loggerServer';
import { requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { readHeEngEmailStatus } from '@/lib/hypothesisEngine/engEmailVerification';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/eng-email/status — подтверждена ли почта клиента
 * ENG-кабинета. Читает страница /client/eng/verify-email.
 *
 * Ответ `{ state, email, last_sent_at, expired_link_sent_at }`, state — одно из:
 *  - 'verified'     — подтверждена для текущего адреса;
 *  - 'pending'      — нет. Про ссылку на этот адрес (не больше одного поля):
 *                     last_sent_at — когда ушла ссылка, которая ещё действует
 *                     («откройте её»); expired_link_sent_at — когда ушла
 *                     ссылка, срок которой (48 ч) вышел («отправьте новую»);
 *                     оба null — ссылка не уходила;
 *  - 'not_required' — проверка не к этому аккаунту (сотрудник, демо);
 *  - 'unavailable'  — таблицы ещё нет (миграция 20261010_0001 не применена)
 *                     либо сбой чтения: сказать нельзя.
 * email — только у 'pending' / 'verified' (адрес самого клиента), отметки
 * ссылки — только у 'pending'. Срок считает сервер (readHeEngEmailStatus), а
 * не часы браузера.
 * Скоуп — id пользователя сессии; почему роут вне /api/client/eng — шапка
 * ../confirm/route.ts.
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  // Демо ходит фикстурами и ничего не запускает — подтверждать ему нечего.
  if (result.auth.isDemo) {
    return NextResponse.json({ state: 'not_required', email: null, last_sent_at: null, expired_link_sent_at: null });
  }
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const gate = await requireEngMarket(supabaseAdmin, userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  const status = await readHeEngEmailStatus(supabaseAdmin, userId);
  if (status.state === 'error' || status.state === 'table_missing') {
    if (status.state === 'error') {
      void logWarn('client.eng.verify_email.status_failed', status.message, { userId });
    }
    return NextResponse.json({ state: 'unavailable', email: null, last_sent_at: null, expired_link_sent_at: null });
  }
  if (status.state === 'not_required') {
    return NextResponse.json({ state: 'not_required', email: null, last_sent_at: null, expired_link_sent_at: null });
  }
  return NextResponse.json({
    state: status.state,
    email: status.email,
    last_sent_at: status.state === 'pending' ? status.lastSentAt : null,
    expired_link_sent_at: status.state === 'pending' ? status.expiredLinkSentAt : null,
  });
}
