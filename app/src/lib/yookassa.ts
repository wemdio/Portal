import 'server-only';

const YOOKASSA_API = 'https://api.yookassa.ru/v3';

const shopId = process.env.YOOKASSA_SHOP_ID;
const secretKey = process.env.YOOKASSA_SECRET_KEY;

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
}

export async function createYookassaInvoice(params: CreateInvoiceParams): Promise<YookassaInvoice> {
  const expiresAt =
    params.expiresAt ??
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const body = {
    payment_data: {
      amount: {
        value: params.amount.toFixed(2),
        currency: params.currency ?? 'RUB',
      },
      capture: true,
      description: params.description,
      // save_payment_method enables recurring charges after the first payment
      ...(params.savePaymentMethod ? { save_payment_method: true } : {}),
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

  const res = await fetch(`${YOOKASSA_API}/invoices`, {
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
    throw new Error(`YooKassa error ${res.status}: ${JSON.stringify(err)}`);
  }

  return (await res.json()) as YookassaInvoice;
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
