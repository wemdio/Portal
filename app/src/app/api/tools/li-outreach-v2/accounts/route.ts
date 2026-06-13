import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Статус LinkedIn-аккаунта пользователя (li2_accounts) для UI.
 *
 * Раньше GET-ручки для li2_accounts не было вообще — статусы needs_captcha /
 * disconnected / last_error были невидимы оператору, и он не знал, что аккаунт
 * встал (а значит и когда нажимать resume-from-captcha). Эта ручка их отдаёт.
 *
 * Возвращает null-аккаунт (account: null), если строки ещё нет — это нормально
 * до первого старта кампании (li2_accounts создаётся upsert'ом в /start).
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.accounts.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const { data, error } = await auth.supabase
      .from('li2_accounts')
      .select('id, status, runtime_status, last_error, last_heartbeat_at, updated_at')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({ account: data ?? null });
  });
}
