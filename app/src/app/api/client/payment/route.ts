import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { calcBillingAmount, isPaymentLocked, SETUP_DAYS, TEST_PERIOD_MINUTES_BY_PERIOD, TEST_SETUP_MINUTES } from '@/lib/tariffs';
import type { BillingPeriod, ClientTariffRow } from '@/lib/tariffs';
import { ensurePendingInvoiceForTariff } from '@/lib/billing';
import { cancelYookassaPayment, isYookassaConfigured } from '@/lib/yookassa';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/payment
 *
 * Returns a YooKassa payment URL the logged-in client can use to pay their
 * subscription. Pre-fix-2026-06: this route created the invoice lazily here.
 * Now it delegates to ensurePendingInvoiceForTariff so the same idempotent
 * path is used whether the invoice was already auto-created (admin activate
 * path) or is being created on-demand from this safety-net call.
 *
 * The route only gates the action: it's reserved for clients in
 * autopayment mode whose subscription is currently locked behind a payment.
 * The helper enforces the same billing_mode='autopayment' precondition, but
 * the early-return here gives the client a friendlier message.
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data: tariff } = await supabaseAdmin
    .from('client_tariffs')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (!tariff) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
  if (!isPaymentLocked(tariff as ClientTariffRow)) {
    return NextResponse.json({ error: 'Оплата не требуется' }, { status: 400 });
  }
  if (tariff.billing_mode !== 'autopayment') {
    return NextResponse.json({ error: 'Этот режим не поддерживает оплату из ЛК' }, { status: 400 });
  }

  const ensured = await ensurePendingInvoiceForTariff({
    userId,
    reason: 'client_self',
    isTestShop: tariff.is_test_shop === true,
  });

  if (!ensured.yookassaUrl) {
    const message = ensured.yookassaError ?? 'Не удалось получить ссылку на оплату';
    // 502 when YK was reachable but errored, 503 when not configured at all,
    // 500 for anything else. The helper's English-leading messages are stable
    // enough to discriminate without exposing internals.
    const status = /не настроены/i.test(message) ? 503
      : /платёжной системы|Yookassa/i.test(message) ? 502
      : 500;
    return NextResponse.json({ error: message, invoice_id: ensured.invoiceId }, { status });
  }

  return NextResponse.json({
    payment_url: ensured.yookassaUrl,
    invoice_id: ensured.invoiceId,
    reused: ensured.reused,
  });
}

/**
 * POST /api/client/payment — клиент впервые выбирает тариф и платит.
 *
 * Тело:
 *   { tariff_type: 'standard' | 'pro', billing_period: 'month'|'quarter'|'half_year'|'year' }
 *
 * Логика:
 *   1. Грузим client_tariffs. Если paid_at уже set — отказ (уже оплачена).
 *   2. Обновляем row: tariff_type, billing_period, billing_amount, billing_mode='autopayment',
 *      is_active=true, payment_locked=true, setup_until=now+SETUP_DAYS дней.
 *   3. Вызываем ensurePendingInvoiceForTariff — он создаст ЮKassa инвойс
 *      и вернёт payment_url. Webhook на оплате обновит paid_at + paid_until
 *      через applyInvoicePaidToTariff() (paid_until = setup_until + период).
 */
export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let body: { tariff_type?: string; billing_period?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const tariffType = body.tariff_type;
  const billingPeriod = body.billing_period as BillingPeriod | undefined;
  if (tariffType !== 'standard' && tariffType !== 'pro') {
    return NextResponse.json({ error: 'Неподдерживаемый тариф' }, { status: 400 });
  }
  if (!billingPeriod || !['month', 'quarter', 'half_year', 'year'].includes(billingPeriod)) {
    return NextResponse.json({ error: 'Неподдерживаемый период' }, { status: 400 });
  }

  const { data: tariff } = await supabaseAdmin
    .from('client_tariffs')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (!tariff) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
  if (tariff.paid_at) {
    return NextResponse.json({ error: 'Подписка уже оплачена' }, { status: 400 });
  }

  // Тест-магазин — персистентный флаг на профиле клиента (см. admin/users).
  // При нём используем фиксированные тестовые цены (10/15/20 ₽ Стандарт,
  // 11/16/21 ₽ Про), а setup-фазу схлопываем в 5 минут вместо 15 дней —
  // чтобы прогнать полный autopayment loop без ожидания.
  const isTestShop = tariff.is_test_shop === true;
  const amount = calcBillingAmount(tariffType, billingPeriod, isTestShop);
  if (!amount) {
    return NextResponse.json({ error: 'Не удалось посчитать сумму' }, { status: 400 });
  }

  const now = new Date();
  const setupUntil = new Date(now);
  if (isTestShop) {
    setupUntil.setMinutes(setupUntil.getMinutes() + TEST_SETUP_MINUTES);
  } else {
    setupUntil.setDate(setupUntil.getDate() + SETUP_DAYS);
  }

  // В тест-режиме paid_until должен прибавляться минутами через
  // test_period_minutes (его уже уважают webhook + cron renew). Quarter в
  // тест-магазине не поддерживается — UI его не отдаёт.
  const testPeriodMinutes = isTestShop ? (TEST_PERIOD_MINUTES_BY_PERIOD[billingPeriod] ?? null) : null;

  const { error: updateErr } = await supabaseAdmin
    .from('client_tariffs')
    .update({
      tariff_type: tariffType,
      billing_period: billingPeriod,
      billing_amount: amount,
      billing_mode: 'autopayment',
      is_active: true,
      payment_locked: true,
      setup_until: setupUntil.toISOString(),
      test_period_minutes: testPeriodMinutes,
      updated_at: now.toISOString(),
    })
    .eq('user_id', userId);

  if (updateErr) {
    return NextResponse.json({ error: `Не удалось обновить тариф: ${updateErr.message}` }, { status: 500 });
  }

  const ensured = await ensurePendingInvoiceForTariff({
    userId,
    reason: 'client_self',
    isTestShop,
  });

  if (!ensured.yookassaUrl) {
    const message = ensured.yookassaError ?? 'Не удалось получить ссылку на оплату';
    return NextResponse.json({ error: message, invoice_id: ensured.invoiceId }, { status: 500 });
  }

  return NextResponse.json({
    payment_url: ensured.yookassaUrl,
    invoice_id: ensured.invoiceId,
  });
}

/**
 * DELETE /api/client/payment — клиент отменяет незакрытый счёт, чтобы выбрать
 * другой тариф.
 *
 * Разрешено только в состоянии «выбрал тариф → перекинуло в ЮКассу → не
 * оплатил»: paid_at=null, billing_mode='autopayment', payment_locked=true.
 * Если клиент уже оплатил — смену тарифа обсуждают через поддержку.
 *
 * Логика:
 *   1. Гейт по состоянию тарифа (см. выше).
 *   2. Ищем все pending-инвойсы клиента (client_self-flow создаёт один, но на
 *      всякий случай отменяем все — старые могли остаться от re-tryев).
 *   3. Каждый инвойс: отменяем в ЮКассе (cancelYookassaPayment), затем
 *      archived_at + status='cancelled' в БД. Ошибку ЮКассы логируем и
 *      идём дальше — счёт мог быть уже expired.
 *   4. Сбрасываем client_tariffs в inactive-состояние: is_active=false,
 *      payment_locked=false, setup_until=null, billing_mode/amount/period=null.
 *      На фронте это триггерит рендер TariffSelectionWidget заново.
 */
export async function DELETE(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data: tariff } = await supabaseAdmin
    .from('client_tariffs')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (!tariff) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
  if (tariff.paid_at) {
    return NextResponse.json(
      { error: 'Подписка уже оплачена — смену тарифа обсудите с менеджером' },
      { status: 400 },
    );
  }
  if (tariff.billing_mode !== 'autopayment') {
    return NextResponse.json(
      { error: 'Этот режим не поддерживает смену тарифа из ЛК' },
      { status: 400 },
    );
  }
  if (!tariff.payment_locked) {
    return NextResponse.json(
      { error: 'Счёт уже не выставлен — тариф можно выбрать заново' },
      { status: 400 },
    );
  }

  const { data: pending } = await supabaseAdmin
    .from('invoices')
    .select('id, yookassa_payment_id, is_test_shop')
    .eq('client_user_id', userId)
    .eq('status', 'pending')
    .is('archived_at', null);

  let cancelledCount = 0;
  for (const inv of pending ?? []) {
    const isTestShop = inv.is_test_shop === true;
    if (inv.yookassa_payment_id && isYookassaConfigured(isTestShop)) {
      try {
        await cancelYookassaPayment(inv.yookassa_payment_id, isTestShop);
      } catch (ykErr) {
        // Счёт мог быть уже expired/canceled в ЮКассе — не блокируем сброс.
        await logError('client.payment.cancel.yk.failed', ykErr, {
          userId,
          invoice_id: inv.id,
          yk_id: inv.yookassa_payment_id,
        });
      }
    }
    const { error: archiveErr } = await supabaseAdmin
      .from('invoices')
      .update({ archived_at: new Date().toISOString(), status: 'cancelled' })
      .eq('id', inv.id);
    if (archiveErr) {
      await logError('client.payment.cancel.archive.failed', archiveErr, {
        userId,
        invoice_id: inv.id,
      });
    } else {
      cancelledCount += 1;
    }
  }

  const { error: resetErr } = await supabaseAdmin
    .from('client_tariffs')
    .update({
      is_active: false,
      payment_locked: false,
      billing_mode: null,
      billing_amount: null,
      billing_period: null,
      setup_until: null,
      test_period_minutes: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (resetErr) {
    await logError('client.payment.reset.tariff.failed', resetErr, { userId });
    return NextResponse.json(
      { error: `Не удалось сбросить тариф: ${resetErr.message}` },
      { status: 500 },
    );
  }

  await logAudit(
    'client.payment.tariff_reset',
    'Клиент отменил незакрытый счёт и вернулся к выбору тарифа',
    { cancelled_invoices: cancelledCount, total_pending: pending?.length ?? 0 },
    { userId },
  );

  return NextResponse.json({ ok: true, cancelled: cancelledCount });
}
