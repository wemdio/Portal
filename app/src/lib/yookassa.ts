import 'server-only';

const YOOKASSA_API = 'https://api.yookassa.ru/v3';

const shopId = process.env.YOOKASSA_SHOP_ID;
const secretKey = process.env.YOOKASSA_SECRET_KEY;
const DEFAULT_INVOICE_VALIDITY_DAYS = 30;
const INVOICE_EXPIRES_AT_SAFETY_BUFFER_MS = 15 * 60 * 1000;

function basicAuth(): string {
  if (!shopId || !secretKey) {
    throw new Error('YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY are not configured');
  }
  return 'Basic ' + Buffer.from(`${shopId}:${secretKey}`).toString('base64');
}

export interface YookassaAmount {
  value: string;
  currency: string;
}

/* ─── Invoice API types ─── */

export interface YookassaCartItem {
  description: string;
  quantity: number;
  /** Price per unit in the Invoices API */
  price: YookassaAmount;
  discount_price?: YookassaAmount;
  /** 1=Без НДС, 2=НДС 0%, 3=НДС 10%, 4=НДС 20% — only needed for receipt */
  vat_code?: 1 | 2 | 3 | 4;
}

/* ─── 54-ФЗ receipt types ─── */
/**
 * VAT codes per YooKassa 54-FZ reference:
 * 1=Без НДС, 2=НДС 0%, 3=НДС 10%, 4=НДС 20%,
 * 5=10/110, 6=20/120, 7=НДС 5%, 8=НДС 7%, 9=5/105, 10=7/107,
 * 11=НДС 22% (с 2026-01-01), 12=22/122 (с 2026-01-01).
 */
export type YookassaVatCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
/** "Признак способа расчёта" — only full_prepayment and full_payment are supported for invoices */
export type YookassaPaymentMode = 'full_prepayment' | 'full_payment';
/** "Признак предмета расчёта" — most common is "service" for SaaS */
export type YookassaPaymentSubject =
  | 'commodity' | 'excise' | 'job' | 'service' | 'payment' | 'casino'
  | 'gambling_bet' | 'gambling_prize' | 'lottery' | 'lottery_prize'
  | 'intellectual_activity' | 'agent_commission' | 'property_right'
  | 'non_operating_gain' | 'sales_tax' | 'resort_fee' | 'marked'
  | 'non_marked' | 'marked_excise' | 'non_marked_excise' | 'fine'
  | 'tax' | 'lien' | 'cost' | 'agent_withdrawals'
  | 'pension_insurance_without_payouts' | 'pension_insurance_with_payouts'
  | 'health_insurance_without_payouts' | 'health_insurance_with_payouts'
  | 'health_insurance' | 'another';

export interface YookassaReceiptCustomer {
  /** At least one of email or phone is required by 54-FZ */
  email?: string;
  phone?: string;
  full_name?: string;
  inn?: string;
}

export interface YookassaReceiptItem {
  description: string;
  /** YooKassa accepts a number; sent as a string formatted to 3 decimals */
  quantity: string;
  amount: YookassaAmount;
  vat_code: YookassaVatCode;
  payment_mode: YookassaPaymentMode;
  payment_subject: YookassaPaymentSubject;
}

export interface YookassaReceipt {
  customer: YookassaReceiptCustomer;
  items: YookassaReceiptItem[];
  /**
   * Required only when the merchant has multiple tax systems registered.
   * Leave undefined to let YooKassa use the shop's default.
   * 1=ОСН, 2=УСН доходы, 3=УСН доход-расход, 4=ЕНВД, 5=ЕСХН, 6=Патент.
   */
  tax_system_code?: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface YookassaInvoice {
  id: string;
  status: 'pending' | 'succeeded' | 'canceled';
  cart: YookassaCartItem[];
  /** Top-level invoice URL (present in some response formats) */
  url?: string;
  description?: string | null;
  expires_at: string;
  created_at: string;
  /** delivery_method.url is the canonical payment link */
  delivery_method?: { type: string; url?: string };
  payment_details?: {
    payment_id: string;
    status: string;
  } | null;
  metadata?: Record<string, string>;
}

/** Extract the payment URL from a YooKassa invoice response */
export function extractInvoiceUrl(inv: YookassaInvoice): string | null {
  return inv.url ?? inv.delivery_method?.url ?? null;
}

export interface CreateInvoiceParams {
  amount: number;
  currency?: string;
  description: string;
  invoiceId: string;
  companyName: string;
  /** Must be unique per invoice — use the DB invoice id */
  idempotencyKey: string;
  /** ISO 8601 — max 30 days from now. Defaults to 30 days. */
  expiresAt?: string;
  /**
   * When true, the client's payment method is saved after payment
   * so it can be used for future recurring charges.
   * Requires autopayments to be enabled on the YooKassa merchant account
   * (contact your YooKassa manager to enable this feature).
   */
  savePaymentMethod?: boolean;
  /**
   * 54-FZ receipt block — REQUIRED when the YooKassa shop has fiscalization
   * (онлайн-касса) enabled. Without it, the customer-facing payment step on
   * yookassa.ru fails with "internal command error" even though invoice
   * creation returns 201. The first-attempt working defaults
   * (vat_code=1 / payment_subject="service" / payment_mode="full_payment")
   * match what our other services (e.g. telegram-bot) use successfully.
   */
  receipt?: YookassaReceipt;
}

type YookassaErrorResponse = {
  type?: string;
  id?: string;
  description?: string;
  parameter?: string;
  code?: string;
};

export function getDefaultYookassaInvoiceExpiresAt(now = new Date()): string {
  const expiresAt = new Date(now.getTime());
  expiresAt.setUTCDate(expiresAt.getUTCDate() + DEFAULT_INVOICE_VALIDITY_DAYS);
  expiresAt.setTime(expiresAt.getTime() - INVOICE_EXPIRES_AT_SAFETY_BUFFER_MS);
  expiresAt.setUTCSeconds(0, 0);
  return expiresAt.toISOString();
}

function isExpiresAtTooBigError(err: YookassaErrorResponse): boolean {
  return err.parameter === 'expires_at' && err.description === 'invalid_request.expires_at.too_big';
}

function getResponseDate(res: Response): Date | null {
  const dateHeader = res.headers.get('date');
  if (!dateHeader) return null;
  const date = new Date(dateHeader);
  return Number.isFinite(date.getTime()) ? date : null;
}

function buildInvoiceBody(params: CreateInvoiceParams, expiresAt: string) {
  return {
    payment_data: {
      amount: {
        value: params.amount.toFixed(2),
        currency: params.currency ?? 'RUB',
      },
      capture: true,
      description: params.description,
      // save_payment_method enables recurring charges after the first payment
      ...(params.savePaymentMethod ? { save_payment_method: true } : {}),
      // receipt: required by 54-FZ when fiscalization is enabled on the shop.
      // Without it, paying the invoice on yookassa.ru fails with
      // "internal command error" even though invoice creation returns 201.
      ...(params.receipt ? { receipt: params.receipt } : {}),
      metadata: {
        invoice_id: params.invoiceId,
        company_name: params.companyName,
      },
    },
    cart: [
      {
        description: params.description,
        quantity: 1.0,
        price: {
          value: params.amount.toFixed(2),
          currency: params.currency ?? 'RUB',
        },
      },
    ],
    delivery_method_data: { type: 'self' },
    locale: 'ru_RU',
    expires_at: expiresAt,
    description: params.description,
    metadata: {
      invoice_id: params.invoiceId,
      company_name: params.companyName,
    },
  };
}

async function postYookassaInvoice(
  body: ReturnType<typeof buildInvoiceBody>,
  idempotencyKey: string,
): Promise<{ invoice?: YookassaInvoice; error?: YookassaErrorResponse; response: Response }> {
  const res = await fetch(`${YOOKASSA_API}/invoices`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/json',
      'Idempotence-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return {
      error: await res.json().catch(() => ({})),
      response: res,
    };
  }

  return {
    invoice: (await res.json()) as YookassaInvoice,
    response: res,
  };
}

export async function createYookassaInvoice(params: CreateInvoiceParams): Promise<YookassaInvoice> {
  const expiresAt = params.expiresAt ?? getDefaultYookassaInvoiceExpiresAt();
  const result = await postYookassaInvoice(buildInvoiceBody(params, expiresAt), params.idempotencyKey);

  if (result.invoice) return result.invoice;

  if (!params.expiresAt && result.error && isExpiresAtTooBigError(result.error)) {
    const yookassaNow = getResponseDate(result.response) ?? new Date();
    const retryExpiresAt = getDefaultYookassaInvoiceExpiresAt(yookassaNow);
    const retry = await postYookassaInvoice(
      buildInvoiceBody(params, retryExpiresAt),
      `${params.idempotencyKey}-expires-retry`,
    );

    if (retry.invoice) return retry.invoice;
    throw new Error(`YooKassa error ${retry.response.status}: ${JSON.stringify(retry.error ?? {})}`);
  }

  throw new Error(`YooKassa error ${result.response.status}: ${JSON.stringify(result.error ?? {})}`);
}

export async function getYookassaInvoice(ykInvoiceId: string): Promise<YookassaInvoice> {
  const res = await fetch(`${YOOKASSA_API}/invoices/${ykInvoiceId}`, {
    headers: { Authorization: basicAuth() },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`YooKassa error ${res.status}: ${JSON.stringify(err)}`);
  }

  return (await res.json()) as YookassaInvoice;
}

/* ─── Payment API types (used for webhook processing) ─── */

export interface YookassaPaymentMethod {
  type: string;
  id: string;
  saved: boolean;
  title?: string;
}

export interface YookassaPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  amount: YookassaAmount;
  description: string | null;
  paid: boolean;
  created_at: string;
  captured_at?: string;
  metadata?: Record<string, string>;
  invoice_details?: { invoice_id: string } | null;
  /** Present when save_payment_method=true was used — contains the saved method id */
  payment_method?: YookassaPaymentMethod | null;
}

export interface ChargeRecurringParams {
  amount: number;
  currency?: string;
  description: string;
  paymentMethodId: string;
  /** Idempotency key — use a deterministic value like `${tariffId}-${billingMonth}` */
  idempotencyKey: string;
  /** 54-FZ receipt — required when fiscalization is enabled on the shop. */
  receipt?: YookassaReceipt;
}

/**
 * Build a 54-FZ receipt for a single-line SaaS-style invoice using the same
 * defaults as our other working service (telegram-bot): "Без НДС", "service",
 * "full_payment", tax_system_code from the shop's own settings.
 *
 * Pass a real customer email (or phone) — YooKassa rejects the payment step
 * with "internal command error" when neither is present and fiscalization is on.
 */
export function buildDefaultReceipt(params: {
  customerEmail?: string | null;
  customerPhone?: string | null;
  description: string;
  amount: number;
  currency?: string;
  vatCode?: YookassaVatCode;
  paymentSubject?: YookassaPaymentSubject;
  paymentMode?: YookassaPaymentMode;
}): YookassaReceipt {
  const email = params.customerEmail?.trim() || undefined;
  const phone = params.customerPhone?.trim() || undefined;
  if (!email && !phone) {
    throw new Error('YooKassa receipt requires customer email or phone (54-FZ)');
  }
  return {
    customer: { ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
    items: [
      {
        description: params.description,
        quantity: '1.000',
        amount: {
          value: params.amount.toFixed(2),
          currency: params.currency ?? 'RUB',
        },
        vat_code: params.vatCode ?? 1,
        payment_mode: params.paymentMode ?? 'full_payment',
        payment_subject: params.paymentSubject ?? 'service',
      },
    ],
    // tax_system_code intentionally omitted: shop has one system configured
    // in the YooKassa cabinet and YooKassa fills it in automatically.
  };
}

/**
 * Charge a saved payment method without requiring user interaction.
 *
 * Uses POST /v3/payments with payment_method_id (recurring payment).
 * Requires autopayments to be enabled on the YooKassa merchant account.
 */
export async function chargeRecurringPayment(params: ChargeRecurringParams): Promise<YookassaPayment> {
  const body = {
    amount: {
      value: params.amount.toFixed(2),
      currency: params.currency ?? 'RUB',
    },
    capture: true,
    payment_method_id: params.paymentMethodId,
    description: params.description,
    // receipt required by 54-FZ on fiscalized shops; without it the recurring
    // charge fails the same way invoice payments do.
    ...(params.receipt ? { receipt: params.receipt } : {}),
  };

  const res = await fetch(`${YOOKASSA_API}/payments`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/json',
      'Idempotence-Key': params.idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`YooKassa recurring charge error ${res.status}: ${JSON.stringify(err)}`);
  }

  return (await res.json()) as YookassaPayment;
}

/**
 * Parse YooKassa webhook notification body.
 * YooKassa does not sign webhooks with HMAC — verify by IP allowlist or
 * re-fetch the object from the API.
 */
export function parseYookassaWebhookBody(rawBody: string): {
  type: string;
  event: string;
  object: YookassaPayment;
} {
  return JSON.parse(rawBody);
}

/** Cancel a pending YooKassa invoice so the customer can no longer pay it */
export async function cancelYookassaInvoice(ykInvoiceId: string): Promise<void> {
  const res = await fetch(`${YOOKASSA_API}/invoices/${ykInvoiceId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/json',
      'Idempotence-Key': `cancel-${ykInvoiceId}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`YooKassa cancel error ${res.status}: ${JSON.stringify(err)}`);
  }
}

export function isYookassaConfigured(): boolean {
  return Boolean(shopId && secretKey);
}
