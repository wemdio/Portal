import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Resume аккаунта после ручного прохождения CAPTCHA через VNC :6080.
 *
 * Daemon при детекте /checkpoint/ выставляет li2_accounts.status='needs_captcha'
 * и приостанавливает AccountWorker. Оператор открывает VNC, проходит проверку
 * руками (LinkedIn не разрешает решать CAPTCHA-программно — даже Anti-CAPTCHA
 * сервисы триггерят ban). После успеха клиент шлёт сюда POST, мы флипаем
 * status обратно на 'running', daemon на ближайшем поллинге возродит Worker
 * с сохранёнными в li2_browser_sessions cookies (которые после CAPTCHA уже
 * включают cleared cookie).
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.accounts.resume-from-captcha' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const now = new Date().toISOString();

    const { data: account, error: loadErr } = await auth.supabase
      .from('li2_accounts')
      .select('id, status')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (loadErr) return jsonError(loadErr.message, 500);
    if (!account) return jsonError('No LinkedIn account state for this user', 404);

    // Резюм только из needs_captcha. Из disconnected — нет (там нужен другой
    // flow, например смена пароля). Из running — тоже нет (уже работает).
    if (account.status !== 'needs_captcha') {
      return jsonError(`Account status is "${account.status}", expected "needs_captcha"`, 409);
    }

    const { error: updErr } = await auth.supabase
      .from('li2_accounts')
      .update({
        status: 'running',
        runtime_status: 'resuming',
        last_error: null,
        updated_at: now,
      })
      .eq('user_id', auth.user.id);
    if (updErr) return jsonError(updErr.message, 500);

    await auth.supabase.from('li2_logs').insert({
      user_id: auth.user.id,
      level: 'info',
      message: 'CAPTCHA resolved, daemon resuming',
    });

    return NextResponse.json({ ok: true });
  });
}
