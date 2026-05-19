import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { createYookassaInvoice, extractInvoiceUrl, isYookassaConfigured } from '@/lib/yookassa';
import { isPaymentLocked } from '@/lib/tariffs';
import type { ClientTariffRow } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';

/**
 * POST /api/client/payment
 *
 * Creates a YooKassa invoice for the logged-in client so they can
 * pay their subscription from within their portal (autopayment mode).
 *
 * Returns the invoice URL and QR data to display in the portal.
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

  // Check if an unpaid invoice already exists for this client
  const { data: existingInvoice } = await supabaseAdmin
    .from('invoices')
    .select('id, yookassa_payment_url, yookassa_payment_id')
    .eq('client_user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingInvoice?.yookassa_payment_url) {
    return NextResponse.json({
      payment_url: existingInvoice.yookassa_payment_url,
      invoice_id: existingInvoice.id,
    });
  }

  if (!isYookassaConfigured()) {
    return NextResponse.json({ error: 'Платёжная система не настроена. Свяжитесь с менеджером.' }, { status: 503 });
  }

  // Get client name from profile
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('full_name, email')
    .eq('id', userId)
    .single();

  const companyName = profile?.full_name || profile?.email || userId;
  const tariffLabels: Record<string, string> = { standard: 'Стандарт', pro: 'Про', custom: 'Индивидуальный' };
  const description = `Подписка ${tariffLabels[tariff.tariff_type] ?? tariff.tariff_type} — ${companyName}`;

  // Calculate amount based on tariff type (placeholder — use real pricing)
  const TARIFF_PRICES: Record<string, number> = {
    standard: 15000,
    pro: 25000,
    custom: 30000,
  };
  const amount = TARIFF_PRICES[tariff.tariff_type] ?? 15000;

  // Create invoice in DB first
  const { data: newInvoice, error: insertErr } = await supabaseAdmin
    .from('invoices')
    .insert({
      company_name: companyName,
      client_user_id: userId,
      amount,
      currency: 'RUB',
      description,
      created_by: null,
      status: 'pending',
    })
    .select()
    .single();

  if (insertErr || !newInvoice) {
    await logError('client.payment.create.failed', insertErr, { userId });
    return NextResponse.json({ error: 'Не удалось создать счёт' }, { status: 500 });
  }

  // Create YooKassa invoice
  try {
    const ykInvoice = await createYookassaInvoice({
      amount,
      currency: 'RUB',
      description,
      invoiceId: newInvoice.id,
      companyName,
      idempotencyKey: newInvoice.id,
      // Save payment method so subsequent months can be charged automatically
      savePaymentMethod: true,
    });

    const ykUrl = extractInvoiceUrl(ykInvoice);
    await supabaseAdmin
      .from('invoices')
      .update({ yookassa_payment_id: ykInvoice.id, yookassa_payment_url: ykUrl })
      .eq('id', newInvoice.id);

    await logAudit('client.payment.created', `Self-payment invoice created for ${companyName}`, { userId, invoice_id: newInvoice.id }, {});

    return NextResponse.json({ payment_url: ykUrl, invoice_id: newInvoice.id });
  } catch (ykErr) {
    const msg = ykErr instanceof Error ? ykErr.message : String(ykErr);
    await logError('client.payment.yk.failed', ykErr, { userId, invoice_id: newInvoice.id });
    return NextResponse.json({ error: `Ошибка платёжной системы: ${msg}` }, { status: 502 });
  }
}
