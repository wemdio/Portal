import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isPaymentLocked } from '@/lib/tariffs';
import type { ClientTariffRow } from '@/lib/tariffs';
import { ensurePendingInvoiceForTariff } from '@/lib/billing';

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
