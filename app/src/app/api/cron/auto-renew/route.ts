import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { chargeRecurringPayment, isYookassaConfigured } from '@/lib/yookassa';

export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/auto-renew
 *
 * Automatically renews subscriptions with billing_mode='autopayment' and
 * a saved yookassa_payment_method_id when paid_until is within the next 3 days.
 *
 * Trigger this endpoint via:
 *   - Supabase pg_cron: SELECT cron.schedule('auto-renew', '0 9 * * *', $$SELECT http_get('https://your-domain/api/cron/auto-renew?secret=...')$$);
 *   - Vercel Cron: add to vercel.json
 *   - External cron service (cron-job.org, etc.)
 *
 * Protect with CRON_SECRET env var.
 */
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  if (!isYookassaConfigured()) return NextResponse.json({ error: 'YooKassa not configured' }, { status: 503 });

  const now = new Date();
  // Renew subscriptions expiring in the next 3 days
  const renewBefore = new Date(now);
  renewBefore.setDate(renewBefore.getDate() + 3);

  const { data: due, error: fetchErr } = await supabaseAdmin
    .from('client_tariffs')
    .select('id, user_id, tariff_type, paid_until, yookassa_payment_method_id, billing_mode')
    .eq('auto_renew', true)
    .eq('is_active', true)
    .eq('billing_mode', 'autopayment')
    .not('yookassa_payment_method_id', 'is', null)
    .lte('paid_until', renewBefore.toISOString());

  if (fetchErr) {
    await logError('cron.auto-renew.fetch.failed', fetchErr, {});
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  const TARIFF_PRICES: Record<string, number> = {
    standard: 15000,
    pro: 25000,
    custom: 30000,
  };

  const results: { user_id: string; success: boolean; error?: string }[] = [];

  for (const row of due ?? []) {
    const amount = TARIFF_PRICES[row.tariff_type] ?? 15000;
    const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const idempotencyKey = `autorenew-${row.id}-${billingMonth}`;

    try {
      const payment = await chargeRecurringPayment({
        amount,
        currency: 'RUB',
        description: `Автопродление подписки — ${billingMonth}`,
        paymentMethodId: row.yookassa_payment_method_id!,
        idempotencyKey,
      });

      if (payment.status === 'succeeded') {
        const newPaidUntil = new Date(row.paid_until ?? now);
        newPaidUntil.setMonth(newPaidUntil.getMonth() + 1);

        await supabaseAdmin
          .from('client_tariffs')
          .update({
            paid_at: now.toISOString(),
            paid_until: newPaidUntil.toISOString(),
            payment_locked: false,
            last_renewal_error: null,
            last_renewal_attempt_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('id', row.id);

        await logAudit(
          'cron.auto-renew.success',
          `Auto-renewed subscription for user ${row.user_id}`,
          { user_id: row.user_id, payment_id: payment.id, new_paid_until: newPaidUntil.toISOString() },
          {},
        );

        results.push({ user_id: row.user_id, success: true });
      } else {
        // Payment pending/failed — mark for retry
        await supabaseAdmin
          .from('client_tariffs')
          .update({
            last_renewal_error: `Payment status: ${payment.status}`,
            last_renewal_attempt_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('id', row.id);

        results.push({ user_id: row.user_id, success: false, error: `Payment ${payment.status}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError('cron.auto-renew.charge.failed', err, { user_id: row.user_id });

      await supabaseAdmin
        .from('client_tariffs')
        .update({
          last_renewal_error: msg,
          last_renewal_attempt_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('id', row.id);

      results.push({ user_id: row.user_id, success: false, error: msg });
    }
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
