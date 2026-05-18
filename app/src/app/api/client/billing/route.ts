import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jsonError, requireClientAuth } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

type Body = { unlink_saved_payment?: boolean };

/**
 * POST /api/client/billing
 *
 * Отключение автопродления и сброс сохранённого способа оплаты в нашей БД.
 * Повторные автосписания через крон выполняться не будут; новая привязка
 * возможна при следующей оплате из ЛК.
 */
export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;

  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError('Некорректное тело запроса', 400);
  }

  if (!body.unlink_saved_payment) {
    return jsonError('Укажите unlink_saved_payment', 400);
  }

  const { data: tariff, error: fetchErr } = await supabaseAdmin
    .from('client_tariffs')
    .select('id, billing_mode, yookassa_payment_method_id, auto_renew')
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchErr) {
    await logError('client.billing.fetch.failed', fetchErr, { userId });
    return jsonError('Не удалось загрузить подписку', 500);
  }
  if (!tariff) return jsonError('Подписка не найдена', 404);

  if (tariff.billing_mode !== 'autopayment') {
    return jsonError('Доступно только для режима автоплатежа', 400);
  }

  if (!tariff.yookassa_payment_method_id && !tariff.auto_renew) {
    return jsonError('Автопродление уже отключено', 400);
  }

  const now = new Date().toISOString();
  const { error: updErr } = await supabaseAdmin
    .from('client_tariffs')
    .update({
      yookassa_payment_method_id: null,
      auto_renew: false,
      last_renewal_error: null,
      updated_at: now,
    })
    .eq('user_id', userId);

  if (updErr) {
    await logError('client.billing.unlink.failed', updErr, { userId });
    return jsonError('Не удалось сохранить изменения', 500);
  }

  await logAudit('client.billing.unlinked', 'Client disabled autopay / cleared saved payment method', { userId }, {});

  return NextResponse.json({ ok: true });
}
