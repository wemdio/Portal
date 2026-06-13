import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Останавливает одну кампанию (`status='stopped'`). Если это последняя
 * running-кампания юзера — гасит и сам аккаунт (`li2_accounts.status='stopped'`),
 * иначе daemon продолжает обслуживать остальные кампании этого аккаунта.
 *
 * Раньше эта ручка тоже инсертила в li2_jobs ('stop'-job), но без потребителя
 * это было no-op. Текущий daemon реагирует на флип account.status в течение
 * POLL_INTERVAL_SEC (~5s).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.stop' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const now = new Date().toISOString();

    const { error: cErr } = await auth.supabase
      .from('li2_campaigns')
      .update({
        status: 'stopped',
        runtime_status: 'stop_requested',
        updated_at: now,
      })
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (cErr) return jsonError(cErr.message, 500);

    // Отменяем ещё не выполненные (pending) задачи этой кампании, чтобы воркер
    // (если у юзера есть вторая running-кампания на том же аккаунте) не
    // продолжал слать инвайты/follow-up за остановленную. Демон дополнительно
    // страхует это в executor (проверка campaign.status перед действием).
    await auth.supabase
      .from('li2_tasks')
      .update({ status: 'cancelled' })
      .eq('campaign_id', id)
      .eq('user_id', auth.user.id)
      .eq('status', 'pending');

    // Other running campaigns у того же юзера? Если есть — daemon продолжает,
    // если нет — гасим аккаунт целиком, чтобы daemon снял Worker и освободил
    // browser-семафор для других пользователей.
    const { data: otherRunning } = await auth.supabase
      .from('li2_campaigns')
      .select('id')
      .eq('user_id', auth.user.id)
      .eq('status', 'running')
      .neq('id', id)
      .limit(1);

    if (!otherRunning || otherRunning.length === 0) {
      await auth.supabase
        .from('li2_accounts')
        .update({
          status: 'stopped',
          runtime_status: 'idle',
          updated_at: now,
        })
        .eq('user_id', auth.user.id);
    }

    await auth.supabase.from('li2_logs').insert({
      user_id: auth.user.id,
      campaign_id: id,
      level: 'warning',
      message: 'Campaign stop requested',
    });

    return NextResponse.json({ ok: true });
  });
}
