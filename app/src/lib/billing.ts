import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  buildDefaultReceipt,
  cancelYookassaPayment,
  chargeRecurringPayment,
  createYookassaPayment,
  extractPaymentUrl,
  isYookassaConfigured,
} from '@/lib/yookassa';
import {
  BILLING_PERIOD_MONTHS,
  TARIFF_MONTHLY_PRICE,
  calcBillingAmount,
  type BillingPeriod,
  type ClientTariffRow,
  type TariffType,
} from '@/lib/tariffs';

/**
 * Billing domain: invoice lifecycle for subscriptions in autopayment mode.
 *
 * This module is the single source of truth for "ensure this client has a
 * payable invoice" and "charge their saved card for the next month". Replaces
 * the older lazy-create-on-click path that lived in /api/client/payment and
 * duplicated price tables, and unifies admin/cron/client-initiated flows.
 *
 * Three exports:
 *   - ensurePendingInvoiceForTariff: idempotent helper used by admin/client paths
 *   - mapYookassaErrorRu:            short ru text for UI, used in two webhooks
 *   - chargeMonthlyRenewal:          cron path that records the invoice AND charges
 *
 * Idempotency strategy: we treat an `invoices` row with status='pending' as the
 * authoritative "in-flight" record. ЮКасса /v3/payments holds pending payments
 * a few hours; we conservatively reuse within YK_INVOICE_VALIDITY_MS, anything
 * older gets a fresh /v3/payments call with idempotency=<invoiceId>-rotN suffix.
 */

// Сколько раз переиспользовать одну и ту же confirmation_url у /v3/payments.
// В отличие от /v3/invoices (там URL живёт ~30 дней) у обычного платежа
// pending status держится несколько часов — после этого ЮКасса считает
// payment expired и URL отдаёт ошибку. Берём 6 ч с запасом: если клиент
// возвращается позже — создаём новый payment с новым idempotency-suffix.
const YK_INVOICE_VALIDITY_MS = 6 * 60 * 60 * 1000;

export type EnsureInvoiceReason =
  | 'admin_activate'
  | 'admin_extend'
  | 'client_self'
  | 'cron_renew';

export interface EnsureInvoiceResult {
  /** Our DB invoice row id, present whenever insert succeeded. */
  invoiceId: string | null;
  /** YK payment URL for the customer to click. Null if YK call failed. */
  yookassaUrl: string | null;
  /** When we re-used an existing pending invoice instead of creating one. */
  reused: boolean;
  /** Human-readable error string for the API caller, if anything failed. */
  yookassaError: string | null;
}

interface EnsureInvoiceParams {
  userId: string;
  reason: EnsureInvoiceReason;
  /** Когда true — счёт выставляется через YOOKASSA_TEST_SHOP_ID/SECRET_KEY и
   *  client_tariffs/invoices помечаются is_test_shop=true. */
  isTestShop?: boolean;
}

/**
 * YooKassa cancellation_details.reason → short Russian text suitable for
 * displaying directly to the client. Codes not in the table fall through to
 * a generic "try again or another card" message.
 *
 * Used for both client-side payment failures (webhook payment.canceled) and
 * cron recurring-charge failures (chargeMonthlyRenewal). The raw YK response
 * is always also logged via logError for engineering visibility.
 */
export function mapYookassaErrorRu(reason: string | null | undefined): string {
  switch (reason) {
    case 'insufficient_funds':
      return 'Недостаточно средств на карте.';
    case 'expired_card':
    case 'card_expired':
      return 'Срок действия карты истёк.';
    case 'issuer_unavailable':
    case 'call_issuer':
      return 'Банк отклонил платёж. Свяжитесь с банком.';
    case '3d_secure_failed':
      return 'Не прошла проверка 3-D Secure.';
    case 'payment_method_restricted':
    case 'general_decline':
      return 'Платёж отклонён банком.';
    case 'fraud_suspected':
      return 'Платёж заблокирован системой безопасности.';
    case 'country_forbidden':
      return 'Платежи из вашей страны запрещены.';
    case 'payment_method_limit_exceeded':
      return 'Превышен лимит платежей по карте.';
    case 'permission_revoked':
      return 'Сохранённая карта отвязана. Привяжите карту заново через «Оплатить подписку».';
    default:
      return 'Не удалось списать. Попробуйте снова или другой картой.';
  }
}

/* ─── Helpers ─── */

const TARIFF_LABELS_RU: Record<TariffType, string> = {
  standard: 'Стандарт',
  pro: 'Про',
  custom: 'Индивидуальный',
};

/** Single, universal payment description shown on YooKassa form, fiscal
 *  receipt and admin /invoices view. Kept intentionally short — operators
 *  reported the previous "Подписка X (период) — Company Y" was noisy and
 *  the tariff/period info is already visible in the surrounding columns. */
const INVOICE_DESCRIPTION = 'Подписка на Portal';

function resolveCompanyName(profile: { full_name?: string | null; email?: string | null } | null, userId: string): string {
  return profile?.full_name?.trim() || profile?.email?.trim() || userId;
}

async function lookupClientProfile(userId: string): Promise<{ email: string | null; full_name: string | null } | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('email, full_name')
    .eq('id', userId)
    .maybeSingle();
  return data ?? null;
}

/**
 * Choose the customer email used for the 54-FZ receipt. Prefer the linked
 * client's profile email; fall back to YOOKASSA_FALLBACK_RECEIPT_EMAIL env var.
 * Returns null when neither is available — the caller decides whether to abort.
 */
function pickReceiptEmail(profile: { email: string | null } | null): string | null {
  const email = profile?.email?.trim();
  if (email) return email;
  return process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL?.trim() || null;
}

/**
 * Resolve the amount to charge for the current period of this tariff.
 *
 * Single source of truth: client_tariffs.billing_amount (set when admin chose
 * a period in the activate/extend dialog). For backwards-compat with older
 * subscriptions whose billing_amount/billing_period weren't recorded, we
 * recompute from calcBillingAmount. isTestShop is passed in from the caller
 * (admin path uses the incoming request flag, cron path uses the stored
 * row.is_test_shop) so test-store prices (10/15/20₽ basic, 11/16/21₽ pro)
 * land for test subscriptions instead of prod 40k/65k rates. Returns null
 * for custom tariffs without explicit amount.
 */
function resolveBillingAmount(
  tariff: Pick<ClientTariffRow, 'tariff_type' | 'billing_period' | 'billing_amount'>,
  isTestShop = false,
): number | null {
  if (tariff.billing_amount && tariff.billing_amount > 0) {
    return Number(tariff.billing_amount);
  }
  if (tariff.tariff_type === 'custom') return null;
  const period = (tariff.billing_period as BillingPeriod | null) ?? 'month';
  return calcBillingAmount(tariff.tariff_type, period, isTestShop);
}

/**
 * Description shown on the YooKassa invoice / payment form and on the 54-FZ
 * fiscal receipt. Universal "Подписка на Portal" for every reason
 * (admin_activate / admin_extend / client_self / cron_renew) — the previous
 * format leaked tariff + company name into the description, which operators
 * disliked.
 */
function buildDescription(
  _tariffType: TariffType,
  _period: BillingPeriod | null,
  _companyName: string,
  _reason: EnsureInvoiceReason,
): string {
  return INVOICE_DESCRIPTION;
}

/**
 * Returns the URL ЮКасса redirects the client back to after they complete
 * (or cancel) payment on the hosted checkout. Defaults to the client tariff
 * page so the user lands back where they started. Falls back to a localhost
 * placeholder so local dev still works — ЮКасса only requires a syntactically
 * valid HTTPS URL, it never actually validates the host is reachable.
 */
function buildClientReturnUrl(): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || process.env.PORTAL_PUBLIC_URL || '')
    .replace(/\/+$/, '');
  if (base) return `${base}/client/tariff`;
  return 'https://example.com/return';
}

function isPendingInvoiceStillValid(row: { created_at: string; yookassa_payment_url: string | null }, now = new Date()): boolean {
  if (!row.yookassa_payment_url) return false;
  const created = new Date(row.created_at);
  if (Number.isNaN(created.getTime())) return false;
  return now.getTime() - created.getTime() < YK_INVOICE_VALIDITY_MS;
}

/* ─── ensurePendingInvoiceForTariff ─── */

/**
 * Idempotently ensure the client has a pending invoice with a valid YooKassa
 * payment URL.
 *
 * Behaviour:
 *   1. Loads the client_tariffs row; rejects if billing_mode isn't 'autopayment'.
 *   2. Looks up the most recent pending invoice for this client. If it has a
 *      yookassa_payment_url and was created less than ~30 days ago, returns it
 *      verbatim (reused=true).
 *   3. Otherwise inserts a fresh invoices row, then calls YooKassa to create
 *      the invoice with save_payment_method=true so the chosen card can be
 *      reused for monthly auto-renewal. The YooKassa payment URL is saved on
 *      our row.
 *
 * Errors at the YK call don't undo the invoice insert — the row stays in DB
 * with status='pending' and yookassa_payment_url=null so the admin can see
 * "needs YK retry" in /invoices and either re-trigger from there or call this
 * helper again (it'll then go straight into the create branch with a new
 * idempotency key derived from invoice id + retry suffix).
 */
export async function ensurePendingInvoiceForTariff(
  params: EnsureInvoiceParams,
): Promise<EnsureInvoiceResult> {
  const { userId, reason, isTestShop = false } = params;

  if (!supabaseAdmin) {
    return {
      invoiceId: null,
      yookassaUrl: null,
      reused: false,
      yookassaError: 'Server misconfigured (supabaseAdmin unavailable)',
    };
  }

  const { data: tariff, error: tariffErr } = await supabaseAdmin
    .from('client_tariffs')
    .select('id, user_id, tariff_type, billing_mode, billing_period, billing_amount')
    .eq('user_id', userId)
    .maybeSingle();

  if (tariffErr) {
    await logError('billing.ensure.tariff_fetch.failed', tariffErr, { userId, reason });
    return { invoiceId: null, yookassaUrl: null, reused: false, yookassaError: 'Не удалось загрузить подписку' };
  }
  if (!tariff) {
    return { invoiceId: null, yookassaUrl: null, reused: false, yookassaError: 'Подписка не найдена' };
  }
  if (tariff.billing_mode !== 'autopayment') {
    return {
      invoiceId: null,
      yookassaUrl: null,
      reused: false,
      yookassaError: 'Автосоздание счёта доступно только для подписок с автоплатежом',
    };
  }

  const amount = resolveBillingAmount(tariff as ClientTariffRow, isTestShop);
  if (!amount || amount <= 0) {
    return {
      invoiceId: null,
      yookassaUrl: null,
      reused: false,
      yookassaError: 'Не задана сумма подписки (billing_amount). Установите её в админке.',
    };
  }

  // 1. Try to reuse an existing pending invoice. If the most recent pending
  //    was created against the OTHER shop, archive + cancel it and fall
  //    through to create a fresh one on the requested shop.
  const { data: existing } = await supabaseAdmin
    .from('invoices')
    .select('id, yookassa_payment_url, yookassa_payment_id, created_at, amount, is_test_shop')
    .eq('client_user_id', userId)
    .eq('status', 'pending')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing && existing.is_test_shop !== isTestShop) {
    // Shop switch — kill the stale pending so the client doesn't see two
    // conflicting "pay now" links.
    if (existing.yookassa_payment_id) {
      try {
        await cancelYookassaPayment(existing.yookassa_payment_id, existing.is_test_shop);
      } catch (cancelErr) {
        await logError('billing.ensure.cancel_old_on_shop_switch.failed', cancelErr, {
          userId,
          invoice_id: existing.id,
          old_is_test_shop: existing.is_test_shop,
          new_is_test_shop: isTestShop,
        });
      }
    }
    await supabaseAdmin
      .from('invoices')
      .update({ archived_at: new Date().toISOString(), status: 'cancelled' })
      .eq('id', existing.id);
  } else if (existing && isPendingInvoiceStillValid(existing)) {
    return {
      invoiceId: existing.id,
      yookassaUrl: existing.yookassa_payment_url,
      reused: true,
      yookassaError: null,
    };
  }

  // 2. Need a new invoice. Look up profile for receipt + naming.
  const profile = await lookupClientProfile(userId);
  const companyName = resolveCompanyName(profile, userId);
  const description = buildDescription(
    tariff.tariff_type as TariffType,
    tariff.billing_period as BillingPeriod | null,
    companyName,
    reason,
  );

  // Insert the row first so admins see "пытаемся выставить" even if YK fails.
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
      is_test_shop: isTestShop,
      metadata: { source: reason },
    })
    .select('id, created_at')
    .single();

  if (insertErr || !newInvoice) {
    await logError('billing.ensure.invoice_insert.failed', insertErr, { userId, reason });
    return { invoiceId: null, yookassaUrl: null, reused: false, yookassaError: 'Не удалось создать счёт' };
  }

  // 3. Talk to YooKassa.
  if (!isYookassaConfigured(isTestShop)) {
    return {
      invoiceId: newInvoice.id,
      yookassaUrl: null,
      reused: false,
      yookassaError: isTestShop
        ? 'YOOKASSA_TEST_SHOP_ID / YOOKASSA_TEST_SECRET_KEY не настроены'
        : 'YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не настроены',
    };
  }

  const receiptEmail = pickReceiptEmail(profile);
  if (!receiptEmail) {
    await logError('billing.ensure.no_receipt_email', null, { userId, invoice_id: newInvoice.id });
    return {
      invoiceId: newInvoice.id,
      yookassaUrl: null,
      reused: false,
      yookassaError:
        'Не удалось определить email для чека (54-ФЗ). Задайте email клиента или YOOKASSA_FALLBACK_RECEIPT_EMAIL.',
    };
  }

  try {
    // Универсальный /v3/payments вместо /v3/invoices — продукт «Счета» в
    // ЮКассе подключается отдельно (для тест-магазина по умолчанию выключен,
    // даёт 403 forbidden), а Payments API доступен всем магазинам. Тот же
    // save_payment_method=true + redirect-confirmation, тот же webhook
    // (по yookassa_payment_id), тот же autopay loop.
    const yk = await createYookassaPayment(
      {
        amount,
        currency: 'RUB',
        description,
        invoiceId: newInvoice.id,
        companyName,
        idempotencyKey: newInvoice.id,
        savePaymentMethod: true,
        returnUrl: buildClientReturnUrl(),
        receipt: buildDefaultReceipt({
          customerEmail: receiptEmail,
          description,
          amount,
          currency: 'RUB',
        }),
      },
      isTestShop,
    );
    const ykUrl = extractPaymentUrl(yk);

    await supabaseAdmin
      .from('invoices')
      .update({ yookassa_payment_id: yk.id, yookassa_payment_url: ykUrl })
      .eq('id', newInvoice.id);

    // Mirror the flag onto client_tariffs ONLY after YK accepted the create —
    // otherwise a half-failed shop switch (test toggle flipped but YK call
    // crashed) would leave client_tariffs.is_test_shop pointing at one shop
    // while yookassa_payment_method_id (saved later by webhook) lives on the
    // other, so cron would charge with the wrong credentials.
    await supabaseAdmin
      .from('client_tariffs')
      .update({ is_test_shop: isTestShop, updated_at: new Date().toISOString() })
      .eq('user_id', userId);

    await logAudit(
      'billing.invoice.auto_created',
      `Pending invoice ${newInvoice.id} created for ${companyName} (${reason}${isTestShop ? ', test shop' : ''})`,
      { user_id: userId, invoice_id: newInvoice.id, reason, amount, is_test_shop: isTestShop },
      {},
    );

    return { invoiceId: newInvoice.id, yookassaUrl: ykUrl, reused: false, yookassaError: null };
  } catch (ykErr) {
    const msg = ykErr instanceof Error ? ykErr.message : String(ykErr);
    await logError('billing.ensure.yk_create.failed', ykErr, { userId, invoice_id: newInvoice.id, reason, is_test_shop: isTestShop });
    return { invoiceId: newInvoice.id, yookassaUrl: null, reused: false, yookassaError: `Ошибка платёжной системы: ${msg}` };
  }
}

/* ─── chargeMonthlyRenewal ─── */

export interface MonthlyRenewalResult {
  invoiceId: string | null;
  success: boolean;
  errorRu: string | null;
}

interface RenewalTariffRow {
  id: string;
  user_id: string;
  tariff_type: TariffType;
  paid_until: string | null;
  billing_period: BillingPeriod | null;
  billing_amount: number | null;
  yookassa_payment_method_id: string | null;
  /** Какой магазин YK обслуживает эту подписку. Saved card живёт в том магазине,
   *  где её привязали — cron должен бить теми же кредами. */
  is_test_shop: boolean;
  /** QA only: when set, cron extends paid_until by N minutes instead of 1 month. */
  test_period_minutes: number | null;
}

/**
 * Cron path: record a new invoice in DB then charge the client's saved card.
 *
 * Used by /api/cron/auto-renew. Replaces the inline chargeRecurringPayment
 * call that left no audit trail in /invoices.
 *
 * Sequence:
 *   1. INSERT invoices (pending, amount=resolved). yookassa_payment_url stays
 *      null because the cron flow charges directly via Payment API, not via
 *      the customer-facing Invoice URL.
 *   2. POST /payments with payment_method_id (idempotency = autorenew-{id}-{paid_until_ms}).
 *   3a. On succeeded: invoices→paid, yookassa_payment_id=payment.id; bump
 *       client_tariffs.paid_until by BILLING_PERIOD_MONTHS[billing_period]
 *       (12-month subscriptions extend by 12 months, not 1) — billing_amount
 *       уже содержит сумму ЗА ВЕСЬ ПЕРИОД, продление должно совпадать.
 *   3b. On YK error / non-succeeded status: keep invoice pending, write
 *       last_renewal_error via mapYookassaErrorRu. Next cron run retries with
 *       the same idempotency key (same calendar month) so YooKassa won't
 *       double-charge.
 */
export async function chargeMonthlyRenewal(row: RenewalTariffRow): Promise<MonthlyRenewalResult> {
  if (!supabaseAdmin) {
    return { invoiceId: null, success: false, errorRu: 'Сервер не сконфигурирован' };
  }
  if (!row.yookassa_payment_method_id) {
    return { invoiceId: null, success: false, errorRu: 'Карта не привязана' };
  }
  if (!isYookassaConfigured(row.is_test_shop)) {
    return { invoiceId: null, success: false, errorRu: row.is_test_shop ? 'Тестовый магазин YooKassa не настроен' : 'YooKassa не настроена' };
  }

  const amount = resolveBillingAmount(row, row.is_test_shop);
  if (!amount || amount <= 0) {
    return { invoiceId: null, success: false, errorRu: 'Сумма подписки не задана' };
  }

  const now = new Date();
  // Idempotency-Key привязан к ТЕКУЩЕМУ paid_until — он уникален per-цикл:
  //   • Все ретраи внутри одного цикла (cron упал → следующий тик через 5
  //     мин повторил) используют ОДИН ключ → ЮКасса дедупит, двойного
  //     списания нет.
  //   • После успешного списания paid_until сдвигается на +период → ключ
  //     становится другим → следующий цикл реально снимает с карты.
  // Раньше ключ был привязан к YYYY-MM — на проде ломалось при ретрае
  // через границу месяца (Jan 31 fail → Feb 1 retry с другим ключом →
  // double charge), на тесте — наоборот, склеивало все циклы внутри
  // календарного месяца в одну транзакцию.
  const paidUntilMs = row.paid_until ? new Date(row.paid_until).getTime() : 0;
  const idempotencyKey = `autorenew-${row.id}-${paidUntilMs}`;

  const profile = await lookupClientProfile(row.user_id);
  const companyName = resolveCompanyName(profile, row.user_id);
  const description = buildDescription(row.tariff_type, row.billing_period, companyName, 'cron_renew');

  const receiptEmail = pickReceiptEmail(profile);
  if (!receiptEmail) {
    const errMsg = 'Не задан email для чека (54-ФЗ).';
    await logError('billing.renewal.no_receipt_email', null, { user_id: row.user_id });
    await supabaseAdmin
      .from('client_tariffs')
      .update({
        last_renewal_error: errMsg,
        last_renewal_attempt_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('id', row.id);
    return { invoiceId: null, success: false, errorRu: errMsg };
  }

  // 1. Audit invoice row. yookassa_payment_url stays null — cron charges directly.
  const { data: invoiceRow, error: insertErr } = await supabaseAdmin
    .from('invoices')
    .insert({
      company_name: companyName,
      client_user_id: row.user_id,
      amount,
      currency: 'RUB',
      description,
      created_by: null,
      status: 'pending',
      is_test_shop: row.is_test_shop,
      metadata: { source: 'cron_renew', cycle_paid_until: row.paid_until, tariff_id: row.id },
    })
    .select('id')
    .single();

  if (insertErr || !invoiceRow) {
    await logError('billing.renewal.invoice_insert.failed', insertErr, { user_id: row.user_id });
    return { invoiceId: null, success: false, errorRu: 'Не удалось зафиксировать счёт' };
  }

  // 2. Charge the saved card.
  let paymentSucceeded = false;
  let paymentId: string | null = null;
  let yookassaErrRu: string | null = null;
  let cancellationReason: string | null = null;

  try {
    const payment = await chargeRecurringPayment(
      {
        amount,
        currency: 'RUB',
        description,
        paymentMethodId: row.yookassa_payment_method_id,
        idempotencyKey,
        receipt: buildDefaultReceipt({
          customerEmail: receiptEmail,
          description,
          amount,
          currency: 'RUB',
        }),
      },
      row.is_test_shop,
    );

    paymentId = payment.id;

    if (payment.status === 'succeeded') {
      paymentSucceeded = true;
    } else {
      const paymentWithDetails = payment as {
        cancellation_details?: { reason?: string | null } | null;
      };
      cancellationReason = paymentWithDetails.cancellation_details?.reason ?? null;
      yookassaErrRu = cancellationReason
        ? mapYookassaErrorRu(cancellationReason)
        : `Платёж ${payment.status}.`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reasonMatch = msg.match(/"description":"([^"]+)"/);
    yookassaErrRu = reasonMatch ? mapYookassaErrorRu(reasonMatch[1]) : mapYookassaErrorRu(null);
    await logError('billing.renewal.yk_charge.failed', err, { user_id: row.user_id, invoice_id: invoiceRow.id, is_test_shop: row.is_test_shop });
  }

  // 3a. Success: mark invoice paid, extend the subscription.
  if (paymentSucceeded) {
    // Normal renewal — extend from the existing paid_until so we don't lose
    // already-paid days. Retry after a failure — paid_until is in the past
    // (we set it to NOW in the failure branch below) so extend from NOW,
    // i.e. the client gets a full period from the charge date.
    const base = row.paid_until && new Date(row.paid_until) > now
      ? new Date(row.paid_until)
      : now;
    const newPaidUntil = new Date(base);
    if (row.test_period_minutes && row.test_period_minutes > 0) {
      // QA test mode — short period for autopayment loop testing.
      newPaidUntil.setMinutes(newPaidUntil.getMinutes() + row.test_period_minutes);
    } else {
      // Продлеваем на ТОТ ЖЕ период, что был оплачен (12 мес → +12 мес).
      // До 23.06.2026 здесь было захардкожено +1 месяц — но billing_amount
      // содержит сумму ЗА ВЕСЬ ПЕРИОД (например 624k за 12 мес со скидкой),
      // и продление на 1 мес после списания 624k = клиент платит за год,
      // получает 30 дней. Legacy-подписки без billing_period — fallback на месяц.
      const monthsToExtend = BILLING_PERIOD_MONTHS[row.billing_period ?? 'month'] ?? 1;
      newPaidUntil.setMonth(newPaidUntil.getMonth() + monthsToExtend);
    }

    await supabaseAdmin
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: now.toISOString(),
        yookassa_payment_id: paymentId,
      })
      .eq('id', invoiceRow.id);

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
      'billing.renewal.success',
      `Auto-renewed subscription for user ${row.user_id}`,
      { user_id: row.user_id, invoice_id: invoiceRow.id, payment_id: paymentId, new_paid_until: newPaidUntil.toISOString(), is_test_shop: row.is_test_shop },
      {},
    );

    return { invoiceId: invoiceRow.id, success: true, errorRu: null };
  }

  // 3b. Failure: keep invoice pending, expire access immediately, surface
  // the error to client UI. Setting paid_until=NOW closes the portal right
  // away (getClientStatus → 'expired'); the next cron run will retry the
  // charge as long as paid_until is still ≤ NOW+5min (it is, by definition,
  // since we just set it to NOW). Retry использует ТОТ ЖЕ idem-key
  // (paid_until не сдвинулся) → ЮКасса дедупит, без двойного списания.
  const errMsg = yookassaErrRu ?? mapYookassaErrorRu(null);
  await supabaseAdmin
    .from('client_tariffs')
    .update({
      paid_until: now.toISOString(),
      last_renewal_error: errMsg,
      last_renewal_attempt_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', row.id);

  return { invoiceId: invoiceRow.id, success: false, errorRu: errMsg };
}

/* ─── runAutoRenewBatch ─── */

export interface AutoRenewBatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  results: Array<{ user_id: string; invoice_id: string | null; success: boolean; error?: string }>;
}

/**
 * Find autopay subscriptions whose paid_until is approaching expiry and
 * charge each via chargeMonthlyRenewal. Shared by:
 *   - /api/cron/auto-renew (HTTP fasade for external pingers like pg_cron)
 *   - worker/autoRenewCron.ts (in-process scheduler, runs every 5 min)
 *
 * Renewal window — 5 минут до истечения paid_until (или paid_until уже в
 * прошлом). С тиком 5 мин это означает: каждая подписка попадает в
 * выборку ровно на одном тике — последнем перед истечением либо первом
 * после. Раньше окно было 24ч — для прода работало (месячный цикл »
 * 24ч), но для тестовых подписок с минутными циклами окно ловило их
 * сразу после оплаты и крутило ретраи бесконечно.
 *
 * Idempotency: chargeMonthlyRenewal строит ключ из текущего paid_until —
 * все попытки в пределах одного цикла используют один ключ (ЮКасса
 * дедупит, без двойного списания), после успешного продления ключ
 * меняется и следующий цикл реально снимает с карты.
 */
export async function runAutoRenewBatch(): Promise<AutoRenewBatchResult> {
  if (!supabaseAdmin) {
    return { processed: 0, succeeded: 0, failed: 0, results: [] };
  }

  const now = new Date();
  // 5 мин = тик воркера. Чуть-чуть «вперёд» (вместо 0) даёт буфер чтобы
  // подписка не уходила в expired между тиками.
  const RENEW_LOOKAHEAD_MS = 5 * 60 * 1000;
  const renewBefore = new Date(now.getTime() + RENEW_LOOKAHEAD_MS);

  const { data: due, error: fetchErr } = await supabaseAdmin
    .from('client_tariffs')
    .select('id, user_id, tariff_type, paid_until, yookassa_payment_method_id, billing_mode, billing_period, billing_amount, is_test_shop, test_period_minutes')
    .eq('auto_renew', true)
    .eq('is_active', true)
    .eq('billing_mode', 'autopayment')
    .not('yookassa_payment_method_id', 'is', null)
    .lte('paid_until', renewBefore.toISOString());

  if (fetchErr) {
    await logError('billing.auto_renew.fetch.failed', fetchErr, {});
    return { processed: 0, succeeded: 0, failed: 0, results: [] };
  }

  const results: AutoRenewBatchResult['results'] = [];
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
      test_period_minutes: row.test_period_minutes ?? null,
    });

    results.push({
      user_id: row.user_id,
      invoice_id: renewal.invoiceId,
      success: renewal.success,
      ...(renewal.errorRu ? { error: renewal.errorRu } : {}),
    });
  }

  return {
    processed: results.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

/* ─── exports for tests ─── */

// Re-export internal helpers so tests can pin behaviour without depending on
// the whole orchestrator. Not part of the public contract.
export const __internal = {
  resolveBillingAmount,
  isPendingInvoiceStillValid,
  buildDescription,
  pickReceiptEmail,
  TARIFF_LABELS_RU,
  YK_INVOICE_VALIDITY_MS,
  TARIFF_MONTHLY_PRICE,
  BILLING_PERIOD_MONTHS,
};
