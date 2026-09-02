import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { parseYookassaWebhookBody, verifyYookassaPaymentFromWebhook } from '@/lib/yookassa';
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
 *
 * SECURITY: the endpoint is public (middleware lets every `/webhook` through)
 * and the body is plain JSON, so the request body is treated as UNTRUSTED. It
 * is only used to find which invoice the notification is about. Before any
 * state change we re-fetch the payment from the YooKassa API with our own shop
 * credentials (`verifyYookassaPaymentFromWebhook`) and act solely on that
 * authoritative object: status, captured_at, payment_method, cancellation
 * reason. A forged `{"status":"succeeded"}` therefore cannot mark an invoice
 * paid — the payment must really be succeeded on YooKassa's side.
 *
 * Multi-shop note: both the production and test YooKassa shops are configured
 * to POST to this same endpoint. We disambiguate by the UUID `payment_id` —
 * unique across shops in practice — and look the payment up in the shop the
 * invoice was created in (`invoices.is_test_shop`) first, then in the other
 * one. The test shop's webhook URL must be configured separately in the
 * YooKassa test cabinet, pointing to this same path.
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

  const claimed = event.object;
  if (!claimed?.id || typeof claimed.id !== 'string') {
    return NextResponse.json({ error: 'Missing payment id' }, { status: 400 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Two YK flows write yookassa_payment_id differently:
  //   - Admin manual /invoices (POST /v3/invoices) → stored = YK invoice.id.
  //     Webhook payment carries payment.invoice_details.invoice_id == that.
  //   - Autopay flow (POST /v3/payments — first pay + cron renew)
  //     → stored = YK payment.id. Webhook payment.id == that.
  // NOTE: payment.metadata.invoice_id is OUR DB id, NOT a YK id —
  // do NOT use it for routing (was a bug pre-/v3/payments switch).
  const claimedInvoiceDetailsId = claimed.invoice_details?.invoice_id;
  const candidateIds = [claimedInvoiceDetailsId, claimed.id].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );

  const { data: invoice, error: findErr } = await supabaseAdmin
    .from('invoices')
    .select('id, status, paid_at, client_user_id, yookassa_payment_id, is_test_shop')
    .in('yookassa_payment_id', candidateIds)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findErr) {
    await logError('invoices.webhook.find.failed', findErr, { payment_id: claimed.id });
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  if (!invoice) {
    // Not an invoice we track — acknowledge silently.
    return NextResponse.json({ ok: true });
  }

  // ── Verify with YooKassa before trusting anything from the body ─────────
  const verified = await verifyYookassaPaymentFromWebhook(claimed.id, invoice.is_test_shop === true);
  if (!verified) {
    await logError(
      'invoices.webhook.unverified',
      new Error('Payment not confirmed by YooKassa API — notification rejected'),
      { invoice_id: invoice.id, payment_id: claimed.id, claimed_status: claimed.status ?? null },
    );
    return NextResponse.json({ error: 'Payment not verified' }, { status: 403 });
  }
  const payment = verified.payment;

  // The authoritative payment must really belong to this invoice: either it
  // IS the stored YK id (autopay flow) or it was spawned by the stored YK
  // invoice (manual /invoices flow). Guards against a real-but-foreign payment
  // id being paired with someone else's invoice via a forged invoice_details.
  const storedYkId = invoice.yookassa_payment_id;
  const belongsToInvoice =
    storedYkId === payment.id || (payment.invoice_details?.invoice_id ?? null) === storedYkId;
  if (!belongsToInvoice) {
    await logError(
      'invoices.webhook.mismatch',
      new Error('Verified payment does not belong to matched invoice — notification rejected'),
      {
        invoice_id: invoice.id,
        payment_id: payment.id,
        stored_yk_id: storedYkId,
        yk_invoice_id: payment.invoice_details?.invoice_id ?? null,
      },
    );
    return NextResponse.json({ error: 'Payment does not match invoice' }, { status: 403 });
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
  //
  // Special case `permission_revoked`: the customer (or their bank) revoked
  // our right to charge the saved card directly in YooKassa. The saved
  // payment_method_id is dead on YK's side, so we mirror that locally —
  // null the id and switch off auto_renew so cron stops retrying.
  if (payment.status === 'canceled') {
    const reason = payment.cancellation_details?.reason ?? null;
    const ruText = mapYookassaErrorRu(reason);
    const revoked = reason === 'permission_revoked';

    if (invoice.client_user_id) {
      const update: Record<string, unknown> = {
        last_payment_error: ruText,
        updated_at: new Date().toISOString(),
      };
      if (revoked) {
        update.yookassa_payment_method_id = null;
        update.auto_renew = false;
      }
      await supabaseAdmin
        .from('client_tariffs')
        .update(update)
        .eq('user_id', invoice.client_user_id);
    }

    await logAudit(
      'invoices.webhook.payment_canceled',
      `Payment ${payment.id} for invoice ${invoice.id} canceled (reason: ${reason ?? 'unknown'}${revoked ? ', saved card unlinked' : ''})`,
      { invoice_id: invoice.id, payment_id: payment.id, reason, party: payment.cancellation_details?.party ?? null, unlinked: revoked },
      {},
    );

    return NextResponse.json({ ok: true });
  }

  // ── Other statuses (pending / waiting_for_capture / already-paid) ──
  // Nothing to do; we'll see the terminal event later.
  return NextResponse.json({ ok: true });
}
