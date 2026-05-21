import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { parseYookassaWebhookBody } from '@/lib/yookassa';
import { applyInvoicePaidToTariff } from '@/lib/tariffs';

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
  // Legacy: metadata.invoice_id (payments API).
  const ykInvoiceId =
    (payment as { invoice_details?: { invoice_id?: string } }).invoice_details?.invoice_id ??
    payment.metadata?.invoice_id ??
    null;

  // Find our invoice: first by YK invoice id, then by payment id fallback
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
    // Not an invoice we track — acknowledge silently
    return NextResponse.json({ ok: true });
  }

  const newStatus: string =
    payment.status === 'succeeded' ? 'paid' :
    payment.status === 'canceled' ? 'cancelled' :
    invoice.status;

  if (newStatus !== invoice.status) {
      const { error: updateErr } = await supabaseAdmin
      .from('invoices')
      .update({
        status: newStatus,
        paid_at: payment.status === 'succeeded'
          ? (invoice.paid_at ?? payment.captured_at ?? new Date().toISOString())
          : undefined,
      })
      .eq('id', invoice.id);

    if (updateErr) {
      await logError('invoices.webhook.update.failed', updateErr, { invoice_id: invoice.id });
      return NextResponse.json({ error: 'Update failed' }, { status: 500 });
    }

    await logAudit(
      'invoices.webhook.processed',
      `Invoice ${invoice.id} status → ${newStatus} (payment ${payment.id})`,
      { invoice_id: invoice.id, payment_id: payment.id, new_status: newStatus, event_type: event.event },
      {},
    );
  }

  // If this invoice is linked to a client — update their tariff
  if (payment.status === 'succeeded' && invoice.client_user_id) {
    const pm = (payment as { payment_method?: { id?: string; saved?: boolean } }).payment_method;
    try {
      const tariffUpdate = await applyInvoicePaidToTariff(invoice.client_user_id, {
        paymentMethod: pm ?? null,
      });
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
