import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';
import { type TariffType, type BillingPeriod, SETUP_DAYS, calcBillingAmount, BILLING_PERIOD_MONTHS } from '@/lib/tariffs';
import { ensurePendingInvoiceForTariff } from '@/lib/billing';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireAdminAuth(req: NextRequest) {
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

  if (!isAdmin((profile?.role ?? null) as UserRole | null)) {
    return { error: jsonError('Forbidden', 403) };
  }

  return { user };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id: targetUserId } = await ctx.params;

  const { data, error } = await supabaseAdmin
    .from('client_tariffs')
    .select('*')
    .eq('user_id', targetUserId)
    .maybeSingle();

  if (error) {
    await logError('admin.tariff.get.failed', error, { targetUserId });
    return jsonError('Failed to load tariff', 500);
  }

  return NextResponse.json({ tariff: data ?? null });
}

const VALID_TYPES = new Set<string>(['standard', 'pro', 'custom']);
const VALID_PERIODS = new Set<string>(['month', 'half_year', 'year']);

type TariffBody = {
  tariff_type?: string;
  max_contacts?: number | null;
  max_rows?: number | null;
  max_chains_per_month?: number | null;
  max_domains?: number | null;
  max_emails?: number | null;
  action?: 'activate' | 'deactivate' | 'finish_setup' | 'unlock_payment' | 'extend';
  billing_mode?: 'invoice' | 'autopayment' | null;
  billing_period?: string;
  billing_amount?: number | null;
  /** Создать счёт в тестовом магазине YooKassa (только при autopayment). */
  is_test_shop?: boolean;
  /** QA-only: длительность периода в минутах вместо месяца. Включает test mode для всей подписки. */
  test_minutes?: number | null;
};

/** Normalises body.billing_period/billing_amount, returning [period, amount] or null on invalid. */
function normalisePeriodAndAmount(
  tariffType: TariffType,
  body: TariffBody,
): { period: BillingPeriod | null; amount: number | null; error?: string } {
  if (!body.billing_period) return { period: null, amount: null };
  if (!VALID_PERIODS.has(body.billing_period)) {
    return { period: null, amount: null, error: 'Invalid billing_period' };
  }
  const period = body.billing_period as BillingPeriod;
  if (tariffType === 'custom') {
    const manual = Number(body.billing_amount);
    if (!Number.isFinite(manual) || manual <= 0) {
      return { period, amount: null, error: 'billing_amount required for custom tariff' };
    }
    return { period, amount: manual };
  }
  return { period, amount: calcBillingAmount(tariffType, period) };
}

function clampInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { user } = auth;
  const { id: targetUserId } = await ctx.params;

  let body: TariffBody;
  try {
    body = (await req.json()) as TariffBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  if (body.action === 'unlock_payment') {
    const { data: existingForUnlock } = await supabaseAdmin
      .from('client_tariffs')
      .select('id')
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (!existingForUnlock) return jsonError('Subscription not found', 404);

    const { error: unlockErr } = await supabaseAdmin
      .from('client_tariffs')
      .update({ payment_locked: false, updated_at: new Date().toISOString() })
      .eq('user_id', targetUserId);

    if (unlockErr) {
      await logError('admin.tariff.unlock.failed', unlockErr, { targetUserId });
      return jsonError('Failed to unlock payment', 500);
    }

    await logAudit('admin.tariff.unlocked', 'Payment lock removed manually', { targetUserId }, { userId: user.id });
    return NextResponse.json({ ok: true, action: 'unlock_payment' });
  }

  if (body.action === 'activate') {
    const now = new Date();
    const setupUntil = new Date(now);
    setupUntil.setDate(setupUntil.getDate() + SETUP_DAYS);

    const billingMode = body.billing_mode ?? null;
    const paymentLocked = billingMode !== null;

    const tariffType = typeof body.tariff_type === 'string' && VALID_TYPES.has(body.tariff_type)
      ? (body.tariff_type as TariffType)
      : 'standard';

    // QA test mode — replaces the 3-day setup phase + monthly period with a
    // short minutes-based period so the autopay cron loop can be exercised in
    // minutes against the real YK shop. Treats every tariff like 'custom'
    // (admin must supply billing_amount) so we don't price-distort the test.
    const testMinutes = body.test_minutes != null && Number.isFinite(Number(body.test_minutes))
      ? Math.floor(Number(body.test_minutes))
      : null;
    const isTestMode = testMinutes != null && testMinutes > 0;

    let period: BillingPeriod | null;
    let amount: number | null;
    if (isTestMode) {
      const manualAmt = Number(body.billing_amount);
      if (!Number.isFinite(manualAmt) || manualAmt <= 0) {
        return jsonError('billing_amount required for test mode', 400);
      }
      period = null;
      amount = manualAmt;
    } else {
      const norm = normalisePeriodAndAmount(tariffType, body);
      if (norm.error) return jsonError(norm.error, 400);
      period = norm.period;
      amount = norm.amount;
    }

    // Test mode: no 3-day setup, instant active period of N minutes.
    // Normal mode: 3-day setup + N months.
    const effectiveSetupUntil = isTestMode ? now : setupUntil;
    const paidUntil = new Date(effectiveSetupUntil);
    if (isTestMode) {
      paidUntil.setMinutes(paidUntil.getMinutes() + testMinutes);
    } else {
      const monthsToAdd = period ? BILLING_PERIOD_MONTHS[period] : 1;
      paidUntil.setMonth(paidUntil.getMonth() + monthsToAdd);
    }

    const subscriptionFields: Record<string, unknown> = {
      is_active: true,
      tariff_type: tariffType,
      paid_at: billingMode ? null : now.toISOString(),
      setup_until: effectiveSetupUntil.toISOString(),
      paid_until: billingMode ? null : paidUntil.toISOString(),
      billing_mode: billingMode,
      payment_locked: paymentLocked,
      billing_period: period,
      billing_amount: amount,
      test_period_minutes: isTestMode ? testMinutes : null,
      updated_at: now.toISOString(),
    };

    const { data: existingRow } = await supabaseAdmin
      .from('client_tariffs')
      .select('id')
      .eq('user_id', targetUserId)
      .maybeSingle();

    const { error } = existingRow
      ? await supabaseAdmin
          .from('client_tariffs')
          .update(subscriptionFields)
          .eq('user_id', targetUserId)
      : await supabaseAdmin
          .from('client_tariffs')
          .insert({ user_id: targetUserId, ...subscriptionFields });

    if (error) {
      await logError('admin.tariff.activate.failed', error, { targetUserId });
      return jsonError('Failed to activate subscription', 500);
    }

    await logAudit(
      'admin.tariff.activate',
      `Client subscription activated${isTestMode ? ` (test mode, ${testMinutes} min)` : ''}`,
      {
        targetUserId,
        tariff_type: tariffType,
        billing_period: period,
        billing_amount: amount,
        setup_until: effectiveSetupUntil.toISOString(),
        billing_mode: billingMode,
        payment_locked: paymentLocked,
        test_period_minutes: isTestMode ? testMinutes : null,
      },
      { userId: user.id },
    );

    // Auto-create a YooKassa invoice so admins see it in /invoices immediately
    // and the client gets a ready-to-pay link in their portal — instead of the
    // old lazy-on-click path. Idempotent: if the activate request is re-sent
    // (admin re-saves the form), the helper reuses the existing pending invoice.
    let invoiceAuto: { invoice_id: string | null; payment_url: string | null; yookassa_error: string | null; is_test_shop: boolean } | null = null;
    if (billingMode === 'autopayment') {
      const isTestShop = body.is_test_shop === true;
      const ensured = await ensurePendingInvoiceForTariff({ userId: targetUserId, reason: 'admin_activate', isTestShop });
      invoiceAuto = {
        invoice_id: ensured.invoiceId,
        payment_url: ensured.yookassaUrl,
        yookassa_error: ensured.yookassaError,
        is_test_shop: isTestShop,
      };
    }

    return NextResponse.json({
      ok: true,
      action: 'activate',
      tariff_type: tariffType,
      setup_until: setupUntil.toISOString(),
      paid_until: billingMode ? null : paidUntil.toISOString(),
      billing_mode: billingMode,
      payment_locked: paymentLocked,
      billing_period: period,
      billing_amount: amount,
      invoice: invoiceAuto,
    });
  }

  // Продление подписки: можно сменить тариф/период. paid_until сдвигается
  // от текущего paid_until (или setup_until/now, если ещё не оплачено).
  if (body.action === 'extend') {
    const { data: existingForExtend } = await supabaseAdmin
      .from('client_tariffs')
      .select('id, is_active, paid_until, setup_until')
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (!existingForExtend) return jsonError('Subscription not found', 404);
    if (!existingForExtend.is_active) return jsonError('Subscription is not active', 400);

    const tariffType = typeof body.tariff_type === 'string' && VALID_TYPES.has(body.tariff_type)
      ? (body.tariff_type as TariffType)
      : 'standard';

    const { period, amount, error: periodErr } = normalisePeriodAndAmount(tariffType, body);
    if (periodErr) return jsonError(periodErr, 400);
    if (!period) return jsonError('billing_period required for extend', 400);

    const now = new Date();
    // База: текущий paid_until (если в будущем), иначе setup_until (если в будущем), иначе now.
    let base = now;
    if (existingForExtend.paid_until && new Date(existingForExtend.paid_until) > now) {
      base = new Date(existingForExtend.paid_until);
    } else if (existingForExtend.setup_until && new Date(existingForExtend.setup_until) > now) {
      base = new Date(existingForExtend.setup_until);
    }
    const newPaidUntil = new Date(base);
    newPaidUntil.setMonth(newPaidUntil.getMonth() + BILLING_PERIOD_MONTHS[period]);

    const billingMode = body.billing_mode ?? null;
    const paymentLocked = billingMode !== null;

    const extendFields: Record<string, unknown> = {
      tariff_type: tariffType,
      billing_period: period,
      billing_amount: amount,
      billing_mode: billingMode,
      payment_locked: paymentLocked,
      // Если оплата через счёт, очищаем paid_until — подписка продлится после оплаты.
      // Если manual (billing_mode=null), сразу проставляем новый paid_until.
      paid_until: billingMode ? null : newPaidUntil.toISOString(),
      updated_at: now.toISOString(),
    };

    const { error: extErr } = await supabaseAdmin
      .from('client_tariffs')
      .update(extendFields)
      .eq('user_id', targetUserId);

    if (extErr) {
      await logError('admin.tariff.extend.failed', extErr, { targetUserId });
      return jsonError('Failed to extend subscription', 500);
    }

    await logAudit(
      'admin.tariff.extend',
      'Client subscription extended with new tariff/period',
      { targetUserId, tariff_type: tariffType, billing_period: period, billing_amount: amount, billing_mode: billingMode },
      { userId: user.id },
    );

    // Same auto-invoice logic as activate. Important during extend because the
    // admin's intent is "client needs to pay for the next period now" — we
    // don't want them to also remember to open the invoices page.
    let invoiceAutoExt: { invoice_id: string | null; payment_url: string | null; yookassa_error: string | null; is_test_shop: boolean } | null = null;
    if (billingMode === 'autopayment') {
      const isTestShop = body.is_test_shop === true;
      const ensured = await ensurePendingInvoiceForTariff({ userId: targetUserId, reason: 'admin_extend', isTestShop });
      invoiceAutoExt = {
        invoice_id: ensured.invoiceId,
        payment_url: ensured.yookassaUrl,
        yookassa_error: ensured.yookassaError,
        is_test_shop: isTestShop,
      };
    }

    return NextResponse.json({
      ok: true,
      action: 'extend',
      tariff_type: tariffType,
      billing_period: period,
      billing_amount: amount,
      paid_until: billingMode ? null : newPaidUntil.toISOString(),
      billing_mode: billingMode,
      payment_locked: paymentLocked,
      invoice: invoiceAutoExt,
    });
  }

  if (body.action === 'finish_setup') {
    const now = new Date();
    const paidUntil = new Date(now);
    paidUntil.setMonth(paidUntil.getMonth() + 1);

    const { data: existingForFinish } = await supabaseAdmin
      .from('client_tariffs')
      .select('id, is_active')
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (!existingForFinish) {
      return jsonError('Subscription not found — activate first', 404);
    }

    const { error } = await supabaseAdmin
      .from('client_tariffs')
      .update({
        is_active: true,
        setup_until: now.toISOString(),
        paid_until: paidUntil.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('user_id', targetUserId);

    if (error) {
      await logError('admin.tariff.finish_setup.failed', error, { targetUserId });
      return jsonError('Failed to finish setup', 500);
    }

    await logAudit(
      'admin.tariff.finish_setup',
      'Client setup finished early',
      { targetUserId, paid_until: paidUntil.toISOString() },
      { userId: user.id },
    );

    return NextResponse.json({
      ok: true,
      action: 'finish_setup',
      setup_until: now.toISOString(),
      paid_until: paidUntil.toISOString(),
    });
  }

  if (body.action === 'deactivate') {
    const { data: existingForDeactivate } = await supabaseAdmin
      .from('client_tariffs')
      .select('id')
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (!existingForDeactivate) {
      return jsonError('Subscription not found', 404);
    }

    const { error } = await supabaseAdmin
      .from('client_tariffs')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', targetUserId);

    if (error) {
      await logError('admin.tariff.deactivate.failed', error, { targetUserId });
      return jsonError('Failed to deactivate subscription', 500);
    }

    await logAudit(
      'admin.tariff.deactivate',
      'Client subscription deactivated',
      { targetUserId },
      { userId: user.id },
    );

    return NextResponse.json({ ok: true, action: 'deactivate' });
  }

  const tariffType = typeof body.tariff_type === 'string' && VALID_TYPES.has(body.tariff_type)
    ? (body.tariff_type as TariffType)
    : 'standard';

  const isCustom = tariffType === 'custom';
  const payload = {
    tariff_type: tariffType,
    max_contacts: isCustom ? clampInt(body.max_contacts) : null,
    max_rows: isCustom ? clampInt(body.max_rows) : null,
    max_chains_per_month: isCustom ? clampInt(body.max_chains_per_month) : null,
    max_domains: isCustom ? clampInt(body.max_domains) : null,
    max_emails: isCustom ? clampInt(body.max_emails) : null,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabaseAdmin
    .from('client_tariffs')
    .select('id')
    .eq('user_id', targetUserId)
    .maybeSingle();

  const { error } = existing
    ? await supabaseAdmin.from('client_tariffs').update(payload).eq('user_id', targetUserId)
    : await supabaseAdmin.from('client_tariffs').insert({ user_id: targetUserId, ...payload });

  if (error) {
    await logError('admin.tariff.put.failed', error, { targetUserId });
    return jsonError('Failed to save tariff', 500);
  }

  await logAudit(
    'admin.tariff.put.success',
    'Client tariff updated',
    { tariffType, targetUserId },
    { userId: user.id },
  );

  return NextResponse.json({ ok: true, tariff_type: tariffType });
}
