import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { parseYookassaWebhookBody } from '@/lib/yookassa';
import { applyInvoicePaidToTariff } from '@/lib/tariffs';
import { mapYookassaErrorRu } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/**
 * POST /api/invoices/webhook
 *
 * YooKassa sends payment notifications here.
 * Configure the webhook URL in the YooKassa merchant dashboard:
 *   https://yookassa.ru/my/merchant/integration/http-notifications
 *
 * YooKassa does not sign notifications with HMAC — they rely on IP allowlisting
 * (185.71.76.0/27, 185.71.77.0/27, 77.75.153.0/25, 77.75.156.11,
 *  77.75.156.35, 77.75.154.128/25, 2a02:5180::/32).
 * We verify by re-fetching the payment from the YooKassa API.
 *
 * Important distinction: YooKassa sends events about Payment objects, not
 * Invoice objects. One YK Invoice (our `invoices` row) can spawn multiple
 * Payment attempts — e.g. the client tries one card, it fails, they retry
 * with another card. So payment.canceled MUST NOT mark our invoice as
 * 'cancelled' — the same invoice URL is still valid for further attempts.
 * Instead we record the failure reason on the client's tariff for UI display
 * and let them try again. Only the Invoice's own succeeded/canceled events
 * (or expires_at elapsing) close the invoice itself.
 */
export async function POST(req: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: 'Cannot read body' }, { status: 400 });
  }

  let event: ReturnType<typeof parseYookassaWebhookBody>;
  try {
    event = parseYookassaWebhookBody(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const payment = event.object;
  if (!payment?.id) {
    return NextResponse.json({ error: 'Missing payment id' }, { status: 400 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // With Invoices API, the YK invoice ID is in payment.invoice_details.invoice_id.
  // Legacy: metadata.invoice_id (payments API). Cron-charged payments don't
  // have invoice_details — find them by payment id then.
  const ykInvoiceId =
    (payment as { invoice_details?: { invoice_id?: string } }).invoice_details?.invoice_id ??
    payment.metadata?.invoice_id ??
    null;

  const { data: invoice, error: findErr } = await supabaseAdmin
    .from('invoices')
    .select('id, status, paid_at, client_user_id')
    .eq('yookassa_payment_id', ykInvoiceId ?? payment.id)
    .maybeSingle();

  if (findErr) {
    await logError('invoices.webhook.find.failed', findErr, { payment_id: payment.id });
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  if (!invoice) {
    // Not an invoice we track — acknowledge silently.
    return NextResponse.json({ ok: true });
  }

  // ── payment.succeeded → mark invoice paid + apply to tariff ───────────
  if (payment.status === 'succeeded' && invoice.status !== 'paid') {
    const { error: updateErr } = await supabaseAdmin
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: invoice.paid_at ?? payment.captured_at ?? new Date().toISOString(),
      })
      .eq('id', invoice.id);

    if (updateErr) {
      await logError('invoices.webhook.update.failed', updateErr, { invoice_id: invoice.id });
      return NextResponse.json({ error: 'Update failed' }, { status: 500 });
    }

    await logAudit(
      'invoices.webhook.processed',
      `Invoice ${invoice.id} marked paid (payment ${payment.id})`,
      { invoice_id: invoice.id, payment_id: payment.id, event_type: event.event },
      {},
    );

    if (invoice.client_user_id) {
      const pm = payment.payment_method;
      try {
        const tariffUpdate = await applyInvoicePaidToTariff(invoice.client_user_id, {
          paymentMethod: pm ?? null,
        });
        // Clear any stale "last payment attempt failed" message — it's done.
        await supabaseAdmin
          .from('client_tariffs')
          .update({ last_payment_error: null, updated_at: new Date().toISOString() })
          .eq('user_id', invoice.client_user_id);

        if (Object.keys(tariffUpdate).length > 0) {
          await logAudit(
            'invoices.webhook.tariff_unlocked',
            `Tariff updated for client ${invoice.client_user_id} after payment`,
            { client_user_id: invoice.client_user_id, tariffUpdate },
            {},
          );
        }
      } catch (tariffErr) {
        await logError('invoices.webhook.tariff_update.failed', tariffErr, { client_user_id: invoice.client_user_id });
      }
    }

    return NextResponse.json({ ok: true });
  }

  // ── payment.canceled → keep invoice pending, surface short error in UI ──
  // The customer can retry the same invoice URL with another card. We only
  // touch client_tariffs.last_payment_error so the LK page can display the
  // mapped russian reason.
  if (payment.status === 'canceled') {
    const reason = payment.cancellation_details?.reason ?? null;
    const ruText = mapYookassaErrorRu(reason);

    if (invoice.client_user_id) {
      await supabaseAdmin
        .from('client_tariffs')
        .update({ last_payment_error: ruText, updated_at: new Date().toISOString() })
        .eq('user_id', invoice.client_user_id);
    }

    await logAudit(
      'invoices.webhook.payment_canceled',
      `Payment ${payment.id} for invoice ${invoice.id} canceled (reason: ${reason ?? 'unknown'})`,
      { invoice_id: invoice.id, payment_id: payment.id, reason, party: payment.cancellation_details?.party ?? null },
      {},
    );

    return NextResponse.json({ ok: true });
  }

  // ── Other statuses (pending / waiting_for_capture / already-paid) ──
  // Nothing to do; we'll see the terminal event later.
  return NextResponse.json({ ok: true });
}
