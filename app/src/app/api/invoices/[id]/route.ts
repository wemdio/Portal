import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isTechnician } from '@/lib/roles';
import type { UserRole } from '@/types';
import { getYookassaInvoice, createYookassaInvoice, cancelYookassaInvoice, extractInvoiceUrl, isYookassaConfigured, buildDefaultReceipt } from '@/lib/yookassa';
import { applyInvoicePaidToTariff } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireTechnicianAuth(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isTechnician((profile?.role ?? null) as UserRole | null)) {
    return { error: jsonError('Forbidden', 403) };
  }

  return { user };
}

/* ─── GET /api/invoices/[id] ─── */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTechnicianAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await ctx.params;

  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('*, creator:created_by(id, full_name, email)')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    await logError('invoices.get.failed', error, { id });
    return jsonError('Failed to load invoice', 500);
  }
  if (!data) return jsonError('Invoice not found', 404);

  return NextResponse.json({ invoice: data });
}

/* ─── PATCH /api/invoices/[id] ─── */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTechnicianAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { user } = auth;
  const { id } = await ctx.params;

  let body: { status?: string; sync_yookassa?: boolean; create_yookassa_payment?: boolean; archive?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('invoices')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (fetchErr) {
    await logError('invoices.patch.fetch.failed', fetchErr, { id });
    return jsonError('Failed to load invoice', 500);
  }
  if (!existing) return jsonError('Invoice not found', 404);

  // Archive (soft-delete) + cancel in YooKassa if pending
  if (body.archive) {
    // Cancel in YooKassa if the invoice is still pending there
    if (existing.yookassa_payment_id && existing.status === 'pending' && isYookassaConfigured()) {
      try {
        await cancelYookassaInvoice(existing.yookassa_payment_id);
      } catch (ykErr) {
        // Log but don't block archiving — YK invoice may already be cancelled/expired
        await logError('invoices.archive.yk_cancel.failed', ykErr, { id, yk_id: existing.yookassa_payment_id });
      }
    }

    const { error: archiveErr } = await supabaseAdmin
      .from('invoices')
      .update({ archived_at: new Date().toISOString(), status: 'cancelled' })
      .eq('id', id);

    if (archiveErr) {
      await logError('invoices.archive.failed', archiveErr, { id });
      return jsonError('Failed to archive invoice', 500);
    }

    await logAudit('invoices.archived', `Invoice ${id} archived and YK cancelled`, { id }, { userId: user.id });
    return NextResponse.json({ ok: true });
  }

  // Create or recover YooKassa invoice / payment URL
  if (body.create_yookassa_payment) {
    if (!isYookassaConfigured()) {
      return jsonError('YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не настроены', 503);
    }
    try {
      if (existing.yookassa_payment_url) {
        // Already has URL — just return current state
        return NextResponse.json({ invoice: existing });
      }

      if (existing.yookassa_payment_id && !existing.yookassa_payment_url) {
        // Invoice exists in YK but URL wasn't saved — fetch it
        const ykInvoice = await getYookassaInvoice(existing.yookassa_payment_id);
        const ykUrl = extractInvoiceUrl(ykInvoice);
        if (ykUrl) {
          await supabaseAdmin.from('invoices').update({ yookassa_payment_url: ykUrl }).eq('id', id);
        }
        await logAudit('invoices.yk_url_recovered', `YK URL recovered for ${id}`, { id }, { userId: user.id });
        const { data: recovered } = await supabaseAdmin.from('invoices').select('*').eq('id', id).single();
        return NextResponse.json({ invoice: recovered });
      }

      // No YK invoice yet — create it.
      // 54-FZ receipt requires a customer email — prefer the linked client's
      // profile email, otherwise fall back to YOOKASSA_FALLBACK_RECEIPT_EMAIL.
      let customerEmail: string | null = null;
      if (existing.client_user_id) {
        const { data: clientProfile } = await supabaseAdmin
          .from('profiles')
          .select('email')
          .eq('id', existing.client_user_id)
          .maybeSingle();
        customerEmail = clientProfile?.email ?? null;
      }
      if (!customerEmail) {
        customerEmail = process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL ?? null;
      }
      if (!customerEmail) {
        return jsonError('Не удалось определить email для чека (54-ФЗ). Привяжите клиента к счёту или задайте YOOKASSA_FALLBACK_RECEIPT_EMAIL.', 400);
      }

      const description = existing.description ?? `Счёт для ${existing.company_name}`;
      const amountNum = Number(existing.amount);
      const ykInvoice = await createYookassaInvoice({
        amount: amountNum,
        currency: existing.currency,
        description,
        invoiceId: existing.id,
        companyName: existing.company_name,
        idempotencyKey: existing.id,
        receipt: buildDefaultReceipt({
          customerEmail,
          description,
          amount: amountNum,
          currency: existing.currency,
        }),
      });

      const { error: ykUpdateErr } = await supabaseAdmin
        .from('invoices')
        .update({
          yookassa_payment_id: ykInvoice.id,
          yookassa_payment_url: extractInvoiceUrl(ykInvoice),
        })
        .eq('id', id);

      if (ykUpdateErr) {
        await logError('invoices.patch.yk_update.failed', ykUpdateErr, { id });
        return jsonError('Invoice created in YK but failed to save', 500);
      }

      await logAudit('invoices.yk_invoice_created', `YK invoice created for ${id}`, { id, yk_id: ykInvoice.id }, { userId: user.id });
      const { data: updatedAfterYk } = await supabaseAdmin.from('invoices').select('*').eq('id', id).single();
      return NextResponse.json({ invoice: updatedAfterYk });
    } catch (ykErr) {
      const msg = ykErr instanceof Error ? ykErr.message : String(ykErr);
      await logError('invoices.patch.yk_create.failed', ykErr, { id });
      return NextResponse.json({ error: `ЮКасса: ${msg}` }, { status: 502 });
    }
  }

  // Sync status from YooKassa invoice
  if (body.sync_yookassa && existing.yookassa_payment_id) {
    try {
      const ykInvoice = await getYookassaInvoice(existing.yookassa_payment_id);
      const newStatus =
        ykInvoice.status === 'succeeded' ? 'paid' :
        ykInvoice.status === 'canceled' ? 'cancelled' :
        existing.status;

      const { error: syncErr } = await supabaseAdmin
        .from('invoices')
        .update({
          status: newStatus,
          paid_at: ykInvoice.status === 'succeeded' && !existing.paid_at
            ? new Date().toISOString()
            : existing.paid_at,
        })
        .eq('id', id);

      if (syncErr) {
        await logError('invoices.patch.sync.failed', syncErr, { id });
        return jsonError('Failed to sync status', 500);
      }

      // When sync confirms the YooKassa invoice is paid and there's a linked
      // client, also unlock their tariff — same effect as the webhook, but
      // works in local dev where YooKassa cannot reach our webhook URL.
      //
      // Apply when EITHER:
      //   1. The invoice just transitioned non-paid → paid (normal case), OR
      //   2. It was already "paid" locally but the tariff is still locked /
      //      paid_at is null (stuck case — e.g. webhook never reached us and
      //      a previous sync only updated the invoice row).
      // The second branch checks tariff state explicitly to avoid double-
      // applying a renewal on a re-sync of an already-processed invoice.
      if (ykInvoice.status === 'succeeded' && existing.client_user_id) {
        try {
          const wasUnpaid = existing.status !== 'paid';
          let needsApply = wasUnpaid;
          if (!needsApply) {
            const { data: tariffCheck } = await supabaseAdmin
              .from('client_tariffs')
              .select('payment_locked, paid_at, billing_mode')
              .eq('user_id', existing.client_user_id)
              .maybeSingle();
            const stuckOnInvoice =
              tariffCheck?.billing_mode === 'invoice' && tariffCheck.payment_locked === true;
            const neverPaid = tariffCheck && !tariffCheck.paid_at;
            needsApply = Boolean(stuckOnInvoice || neverPaid);
          }

          if (needsApply) {
            const tariffUpdate = await applyInvoicePaidToTariff(existing.client_user_id);
            if (Object.keys(tariffUpdate).length > 0) {
              await logAudit(
                'invoices.sync.tariff_unlocked',
                `Tariff updated for client ${existing.client_user_id} after sync`,
                { client_user_id: existing.client_user_id, invoice_id: id, tariffUpdate, viaStuckRecovery: !wasUnpaid },
                { userId: user.id },
              );
            }
          }
        } catch (tariffErr) {
          await logError('invoices.sync.tariff_update.failed', tariffErr, { client_user_id: existing.client_user_id, invoice_id: id });
          // Don't block the sync response — invoice status itself was updated.
        }
      }

      await logAudit('invoices.synced', `Invoice ${id} synced: ${newStatus}`, { id, newStatus }, { userId: user.id });
      const { data: updated } = await supabaseAdmin.from('invoices').select('*').eq('id', id).single();
      return NextResponse.json({ invoice: updated });
    } catch (ykErr) {
      await logError('invoices.yookassa.sync.failed', ykErr, { id });
      return jsonError('Failed to fetch YooKassa status', 502);
    }
  }

  const VALID_STATUSES = new Set(['pending', 'paid', 'cancelled', 'expired']);
  if (body.status && !VALID_STATUSES.has(body.status)) {
    return jsonError('Invalid status', 400);
  }

  const update: Record<string, unknown> = {};
  if (body.status) {
    update.status = body.status;
    if (body.status === 'paid' && !existing.paid_at) {
      update.paid_at = new Date().toISOString();
    }
  }

  if (Object.keys(update).length === 0) {
    return jsonError('Nothing to update', 400);
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('invoices')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (updateErr) {
    await logError('invoices.patch.failed', updateErr, { id });
    return jsonError('Failed to update invoice', 500);
  }

  await logAudit('invoices.updated', `Invoice ${id} updated`, { id, update }, { userId: user.id });

  return NextResponse.json({ invoice: updated });
}
