import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import { isYookassaConfigured } from '@/lib/yookassa';
import { chargeMonthlyRenewal } from '@/lib/billing';
import type { BillingPeriod, TariffType } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/auto-renew
 *
 * Runs daily. For each active autopayment subscription whose paid_until lands
 * within the next 24 hours, inserts a fresh `invoices` row and immediately
 * charges the client's saved YooKassa card. All accounting lives in
 * lib/billing.ts so the same charge-and-record sequence stays consistent
 * with the admin/client paths.
 *
 * Window choice: 1 day (was 3). Trade-off — at most one retry day. If the
 * first attempt fails (insufficient funds / expired card), the cron's same
 * idempotency key (calendar month) blocks YooKassa from double-charging on
 * the retry the following day. Client sees mapped russian error in their
 * tariff page via client_tariffs.last_renewal_error.
 *
 * Protect with CRON_SECRET env var. Trigger via Supabase pg_cron / Vercel
 * Cron / external service. Idempotent across same-day repeated calls because
 * chargeMonthlyRenewal's idempotency key includes year-month, not date.
 */
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  if (!isYookassaConfigured()) return NextResponse.json({ error: 'YooKassa not configured' }, { status: 503 });

  const now = new Date();
  // Renew when paid_until lands in the next 24 hours.
  const renewBefore = new Date(now);
  renewBefore.setDate(renewBefore.getDate() + 1);

  const { data: due, error: fetchErr } = await supabaseAdmin
    .from('client_tariffs')
    .select('id, user_id, tariff_type, paid_until, yookassa_payment_method_id, billing_mode, billing_period, billing_amount, is_test_shop')
    .eq('auto_renew', true)
    .eq('is_active', true)
    .eq('billing_mode', 'autopayment')
    .not('yookassa_payment_method_id', 'is', null)
    .lte('paid_until', renewBefore.toISOString());

  if (fetchErr) {
    await logError('cron.auto-renew.fetch.failed', fetchErr, {});
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  const results: { user_id: string; invoice_id: string | null; success: boolean; error?: string }[] = [];

  for (const row of due ?? []) {
    const renewal = await chargeMonthlyRenewal({
      id: row.id,
      user_id: row.user_id,
      tariff_type: row.tariff_type as TariffType,
      paid_until: row.paid_until,
      billing_period: row.billing_period as BillingPeriod | null,
      billing_amount: row.billing_amount,
      yookassa_payment_method_id: row.yookassa_payment_method_id,
      is_test_shop: row.is_test_shop === true,
    });

    results.push({
      user_id: row.user_id,
      invoice_id: renewal.invoiceId,
      success: renewal.success,
      ...(renewal.errorRu ? { error: renewal.errorRu } : {}),
    });
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return NextResponse.json({
    ok: true,
    processed: results.length,
    succeeded,
    failed,
    results,
  });
}
