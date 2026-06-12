# YooKassa Test Shop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to create invoices and autopayment subscriptions against the YooKassa test shop (`YOOKASSA_TEST_SHOP_ID` / `YOOKASSA_TEST_SECRET_KEY`) alongside the production one — togglable in the user edit modal (autopayment branch) and the manual invoice modal; test invoices show a yellow `🧪 Тест` badge in the `/invoices` table.

**Architecture:** Two new boolean columns — `invoices.is_test_shop` and `client_tariffs.is_test_shop` — propagate through the YooKassa client (which becomes shop-aware on every call), through `lib/billing.ts`, through three API routes (admin tariff PUT, invoices POST/PATCH), through the auto-renew cron, and out into two UI toggles + one table badge.

**Tech Stack:** Next.js 14 App Router, Supabase Postgres, jest (`@jest-environment node`), Tailwind. YooKassa Invoice + Payment APIs.

**Spec:** [`docs/superpowers/specs/2026-06-12-yookassa-test-shop-design.md`](../specs/2026-06-12-yookassa-test-shop-design.md)

---

## File Map

**Create:**
- `supabase/migrations/20260612_0001_invoices_is_test_shop.sql` — add `is_test_shop BOOLEAN NOT NULL DEFAULT FALSE` to `invoices` and `client_tariffs`.

**Modify:**
- `app/src/lib/yookassa.ts` — remove module-level credential caching; add `getYookassaCreds(isTestShop)`; thread `isTestShop` through every public API.
- `app/tests/lib/yookassa.test.ts` — add coverage for the new shop-selection logic.
- `app/src/lib/billing.ts` — `EnsureInvoiceParams` gains `isTestShop`; reuse-vs-create handles shop mismatch; `chargeMonthlyRenewal` threads the flag.
- `app/src/app/api/admin/users/[id]/tariff/route.ts` — accept `is_test_shop` in body for activate/extend, pass through.
- `app/src/app/api/invoices/route.ts` — accept `is_test_shop` in body, save in INSERT, route YK call to selected shop.
- `app/src/app/api/invoices/[id]/route.ts` — read `existing.is_test_shop` and pass it into every YK call.
- `app/src/app/api/cron/auto-renew/route.ts` — SELECT `is_test_shop`, pass into `chargeMonthlyRenewal`.
- `app/src/app/api/invoices/webhook/route.ts` — doc-only comment about shared endpoint for both shops.
- `app/src/app/admin/users/page.tsx` — SubscriptionPanel gets a "Магазин YooKassa" pill row that only shows for autopayment.
- `app/src/app/invoices/InvoicesPageView.tsx` — `Invoice` interface gains `is_test_shop`; CreateModal gets the same pill row; table renders the yellow `🧪 Тест` badge.

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/20260612_0001_invoices_is_test_shop.sql`

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260612_0001_invoices_is_test_shop.sql`:

```sql
-- Allows invoices and autopayment subscriptions to target the YooKassa TEST shop
-- (YOOKASSA_TEST_SHOP_ID / YOOKASSA_TEST_SECRET_KEY) instead of the production
-- one. Set per-row at creation time; never mutated afterwards. Drives:
--   - UI bag in /invoices (yellow «🧪 Тест» pill).
--   - Credential selection in lib/yookassa.ts on every subsequent YK call for
--     this invoice (sync status, cancel, recurring charge via saved card).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS is_test_shop BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE client_tariffs
  ADD COLUMN IF NOT EXISTS is_test_shop BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN invoices.is_test_shop IS
  'TRUE = счёт создан через YOOKASSA_TEST_SHOP_ID/SECRET. Влияет на бейдж в UI и креды для get/cancel/sync.';
COMMENT ON COLUMN client_tariffs.is_test_shop IS
  'TRUE = подписка завязана на тестовый магазин YK. Сохранённая карта и cron auto-renew используют тестовые креды.';
```

- [ ] **Step 2: Apply the migration locally**

Run: `cd app && npm run db:migrate`
Expected: migration runner reports `20260612_0001_invoices_is_test_shop.sql` applied (no errors). Re-running is a no-op because of `IF NOT EXISTS`.

- [ ] **Step 3: Verify the columns landed**

From the project root, against the local dev DB used by Supabase:

```bash
psql "$LOCAL_SUPABASE_DB_URL" -c "\d invoices" | grep is_test_shop
psql "$LOCAL_SUPABASE_DB_URL" -c "\d client_tariffs" | grep is_test_shop
```

Expected: each command prints one line containing `is_test_shop | boolean | not null | false`.

If `LOCAL_SUPABASE_DB_URL` isn't set in your shell, look it up in `.env` or `.env.servers` (key is whatever the project uses for the local-supabase connection — `DATABASE_URL` is also fine).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260612_0001_invoices_is_test_shop.sql
git commit -m "feat(db): add is_test_shop to invoices and client_tariffs"
```

---

## Task 2: Refactor lib/yookassa.ts to be shop-aware

**Files:**
- Modify: `app/src/lib/yookassa.ts`
- Modify: `app/tests/lib/yookassa.test.ts`

- [ ] **Step 1: Write failing test for `isYookassaConfigured(isTestShop)`**

Replace the contents of `app/tests/lib/yookassa.test.ts` with:

```typescript
/** @jest-environment node */

import { getDefaultYookassaInvoiceExpiresAt, isYookassaConfigured } from '@/lib/yookassa';

describe('YooKassa invoice expiration', () => {
  it('keeps the default validity near 30 days with a safety buffer for YooKassa validation', () => {
    const now = new Date('2026-05-20T10:15:42.987Z');

    expect(getDefaultYookassaInvoiceExpiresAt(now)).toBe('2026-06-19T10:00:00.000Z');
  });
});

describe('isYookassaConfigured', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clone so each test mutates an isolated copy; restore in afterEach.
    process.env = { ...originalEnv };
    delete process.env.YOOKASSA_SHOP_ID;
    delete process.env.YOOKASSA_SECRET_KEY;
    delete process.env.YOOKASSA_TEST_SHOP_ID;
    delete process.env.YOOKASSA_TEST_SECRET_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns true for the production shop when both live env vars are set', () => {
    process.env.YOOKASSA_SHOP_ID = 'live-shop';
    process.env.YOOKASSA_SECRET_KEY = 'live-secret';
    expect(isYookassaConfigured()).toBe(true);
    expect(isYookassaConfigured(false)).toBe(true);
  });

  it('returns false for the production shop when either env var is missing', () => {
    process.env.YOOKASSA_SHOP_ID = 'live-shop';
    expect(isYookassaConfigured(false)).toBe(false);
  });

  it('returns true for the test shop when both test env vars are set', () => {
    process.env.YOOKASSA_TEST_SHOP_ID = 'test-shop';
    process.env.YOOKASSA_TEST_SECRET_KEY = 'test-secret';
    expect(isYookassaConfigured(true)).toBe(true);
  });

  it('returns false for the test shop when only live env vars are set', () => {
    process.env.YOOKASSA_SHOP_ID = 'live-shop';
    process.env.YOOKASSA_SECRET_KEY = 'live-secret';
    expect(isYookassaConfigured(true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `cd app && npm test -- yookassa.test.ts`
Expected: `isYookassaConfigured(false)` test calls fail — current signature is no-arg and the module reads env at import time, so the mutations don't reach it. The `getDefaultYookassaInvoiceExpiresAt` test still passes.

- [ ] **Step 3: Refactor `app/src/lib/yookassa.ts`**

Replace lines 1–15 (the module header through `basicAuth`) with the new shop-aware credential plumbing, and update every public function to accept an `isTestShop` flag. The full file body is large — apply the changes below as targeted edits.

**Replace lines 1–15:**

```typescript
import 'server-only';

const YOOKASSA_API = 'https://api.yookassa.ru/v3';

const DEFAULT_INVOICE_VALIDITY_DAYS = 30;
const INVOICE_EXPIRES_AT_SAFETY_BUFFER_MS = 15 * 60 * 1000;

/**
 * Resolve the YooKassa credentials for a given shop. Read lazily on every call
 * so tests (and dev hot-reload) see env mutations, and so the production and
 * test shops can be configured independently without restarting the server.
 *
 * The "test" shop is for QA — admins flip a toggle in /admin/users or the
 * /invoices CreateModal. Production webhooks land on the same endpoint; we
 * disambiguate by the UUID payment_id, not by shop.
 */
function getYookassaCreds(isTestShop: boolean): { shopId: string; secretKey: string } {
  if (isTestShop) {
    const shopId = process.env.YOOKASSA_TEST_SHOP_ID;
    const secretKey = process.env.YOOKASSA_TEST_SECRET_KEY;
    if (!shopId || !secretKey) {
      throw new Error('Тестовый магазин YooKassa не настроен (YOOKASSA_TEST_SHOP_ID / YOOKASSA_TEST_SECRET_KEY).');
    }
    return { shopId, secretKey };
  }
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secretKey) {
    throw new Error('YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY are not configured');
  }
  return { shopId, secretKey };
}

function basicAuth(isTestShop: boolean): string {
  const { shopId, secretKey } = getYookassaCreds(isTestShop);
  return 'Basic ' + Buffer.from(`${shopId}:${secretKey}`).toString('base64');
}
```

**Update `createYookassaInvoice` (was line 231) — change signature, thread through `basicAuth`:**

```typescript
export async function createYookassaInvoice(
  params: CreateInvoiceParams,
  isTestShop: boolean = false,
): Promise<YookassaInvoice> {
  const expiresAt = params.expiresAt ?? getDefaultYookassaInvoiceExpiresAt();
  const result = await postYookassaInvoice(buildInvoiceBody(params, expiresAt), params.idempotencyKey, isTestShop);

  if (result.invoice) return result.invoice;

  if (!params.expiresAt && result.error && isExpiresAtTooBigError(result.error)) {
    const yookassaNow = getResponseDate(result.response) ?? new Date();
    const retryExpiresAt = getDefaultYookassaInvoiceExpiresAt(yookassaNow);
    const retry = await postYookassaInvoice(
      buildInvoiceBody(params, retryExpiresAt),
      `${params.idempotencyKey}-expires-retry`,
      isTestShop,
    );

    if (retry.invoice) return retry.invoice;
    throw new Error(`YooKassa error ${retry.response.status}: ${JSON.stringify(retry.error ?? {})}`);
  }

  throw new Error(`YooKassa error ${result.response.status}: ${JSON.stringify(result.error ?? {})}`);
}
```

**Update `postYookassaInvoice` to take `isTestShop`:**

```typescript
async function postYookassaInvoice(
  body: ReturnType<typeof buildInvoiceBody>,
  idempotencyKey: string,
  isTestShop: boolean,
): Promise<{ invoice?: YookassaInvoice; error?: YookassaErrorResponse; response: Response }> {
  const res = await fetch(`${YOOKASSA_API}/invoices`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(isTestShop),
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
```

**Update `getYookassaInvoice`:**

```typescript
export async function getYookassaInvoice(ykInvoiceId: string, isTestShop: boolean = false): Promise<YookassaInvoice> {
  const res = await fetch(`${YOOKASSA_API}/invoices/${ykInvoiceId}`, {
    headers: { Authorization: basicAuth(isTestShop) },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`YooKassa error ${res.status}: ${JSON.stringify(err)}`);
  }

  return (await res.json()) as YookassaInvoice;
}
```

**Update `chargeRecurringPayment`:**

```typescript
export async function chargeRecurringPayment(
  params: ChargeRecurringParams,
  isTestShop: boolean = false,
): Promise<YookassaPayment> {
  const body = {
    amount: {
      value: params.amount.toFixed(2),
      currency: params.currency ?? 'RUB',
    },
    capture: true,
    payment_method_id: params.paymentMethodId,
    description: params.description,
    ...(params.receipt ? { receipt: params.receipt } : {}),
  };

  const res = await fetch(`${YOOKASSA_API}/payments`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(isTestShop),
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
```

**Update `cancelYookassaInvoice`:**

```typescript
export async function cancelYookassaInvoice(ykInvoiceId: string, isTestShop: boolean = false): Promise<void> {
  const res = await fetch(`${YOOKASSA_API}/invoices/${ykInvoiceId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(isTestShop),
      'Content-Type': 'application/json',
      'Idempotence-Key': `cancel-${ykInvoiceId}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`YooKassa cancel error ${res.status}: ${JSON.stringify(err)}`);
  }
}
```

**Update `isYookassaConfigured`:**

```typescript
export function isYookassaConfigured(isTestShop: boolean = false): boolean {
  if (isTestShop) {
    return Boolean(process.env.YOOKASSA_TEST_SHOP_ID && process.env.YOOKASSA_TEST_SECRET_KEY);
  }
  return Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
}
```

- [ ] **Step 4: Run yookassa tests, verify they pass**

Run: `cd app && npm test -- yookassa.test.ts`
Expected: all tests in `isYookassaConfigured` and the existing `getDefaultYookassaInvoiceExpiresAt` test pass.

- [ ] **Step 5: Type-check the whole app to surface broken call sites**

Run: `cd app && npx tsc --noEmit`
Expected: SUCCESS. Default parameter values (`isTestShop = false`) keep every existing caller working without modification — we'll switch them to explicit `true`-paths in the following tasks.

If TypeScript reports errors in `lib/billing.ts`, `api/invoices/route.ts`, `api/invoices/[id]/route.ts`, or `api/cron/auto-renew/route.ts`, that's a sign the default parameter wasn't applied — re-check the signatures.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/yookassa.ts app/tests/lib/yookassa.test.ts
git commit -m "refactor(yookassa): make every call shop-aware (isTestShop param)"
```

---

## Task 3: Thread `isTestShop` through lib/billing.ts

**Files:**
- Modify: `app/src/lib/billing.ts`

Note: the existing `billing.test.ts` deliberately skips the orchestrator paths (see the header comment in that file) — we follow that convention and verify Task 3 via the API tests (Tasks 4–7) and a manual end-to-end check at the end.

- [ ] **Step 1: Update `EnsureInvoiceParams` and `RenewalTariffRow`**

In `app/src/lib/billing.ts`, find the `EnsureInvoiceParams` interface (around line 60) and add the new field:

```typescript
interface EnsureInvoiceParams {
  userId: string;
  reason: EnsureInvoiceReason;
  /** Когда true — счёт выставляется через YOOKASSA_TEST_SHOP_ID/SECRET_KEY и
   *  client_tariffs/invoices помечаются is_test_shop=true. */
  isTestShop?: boolean;
}
```

Find the `RenewalTariffRow` interface (around line 369) and add:

```typescript
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
}
```

- [ ] **Step 2: Update `ensurePendingInvoiceForTariff` — extract `isTestShop` and handle reuse vs shop-switch**

Replace the function body starting at `export async function ensurePendingInvoiceForTariff(` (around line 204). The destructuring, reuse logic, INSERT, and YK call all change. Full replacement:

```typescript
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

  const amount = resolveBillingAmount(tariff as ClientTariffRow);
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
        await cancelYookassaInvoice(existing.yookassa_payment_id, existing.is_test_shop);
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

  // Mirror the flag onto client_tariffs so cron auto-renew knows which shop
  // owns the saved card after the client pays.
  await supabaseAdmin
    .from('client_tariffs')
    .update({ is_test_shop: isTestShop, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

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
    const yk = await createYookassaInvoice(
      {
        amount,
        currency: 'RUB',
        description,
        invoiceId: newInvoice.id,
        companyName,
        idempotencyKey: newInvoice.id,
        savePaymentMethod: true,
        receipt: buildDefaultReceipt({
          customerEmail: receiptEmail,
          description,
          amount,
          currency: 'RUB',
        }),
      },
      isTestShop,
    );
    const ykUrl = extractInvoiceUrl(yk);

    await supabaseAdmin
      .from('invoices')
      .update({ yookassa_payment_id: yk.id, yookassa_payment_url: ykUrl })
      .eq('id', newInvoice.id);

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
```

- [ ] **Step 3: Update `chargeMonthlyRenewal` — thread `is_test_shop` through every YK call and the invoice INSERT**

Replace the function body starting at `export async function chargeMonthlyRenewal(`. The changes: read `row.is_test_shop`, use it for `isYookassaConfigured`, `chargeRecurringPayment`, and persist on the new `invoices` row. Full replacement:

```typescript
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

  const amount = resolveBillingAmount(row);
  if (!amount || amount <= 0) {
    return { invoiceId: null, success: false, errorRu: 'Сумма подписки не задана' };
  }

  const now = new Date();
  const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const idempotencyKey = `autorenew-${row.id}-${billingMonth}`;

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
      metadata: { source: 'cron_renew', billing_month: billingMonth, tariff_id: row.id },
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
    const newPaidUntil = new Date(row.paid_until ?? now);
    newPaidUntil.setMonth(newPaidUntil.getMonth() + 1);

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

  // 3b. Failure: keep invoice pending, surface short error to client UI.
  const errMsg = yookassaErrRu ?? mapYookassaErrorRu(null);
  await supabaseAdmin
    .from('client_tariffs')
    .update({
      last_renewal_error: errMsg,
      last_renewal_attempt_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', row.id);

  return { invoiceId: invoiceRow.id, success: false, errorRu: errMsg };
}
```

- [ ] **Step 4: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: SUCCESS. (Callers of `ensurePendingInvoiceForTariff` don't pass `isTestShop` yet — default `false` keeps them working until Tasks 4/7 update them.)

- [ ] **Step 5: Run all tests to make sure nothing regressed**

Run: `cd app && npm test -- billing.test.ts yookassa.test.ts`
Expected: all green. The pure-helper tests (`__internal.resolveBillingAmount`, etc.) and `mapYookassaErrorRu` cases are unchanged; the new code lives in orchestrator paths not covered by these unit tests.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/billing.ts
git commit -m "feat(billing): thread is_test_shop through ensure + renew, switch shops on mismatch"
```

---

## Task 4: Admin tariff route accepts `is_test_shop`

**Files:**
- Modify: `app/src/app/api/admin/users/[id]/tariff/route.ts`

- [ ] **Step 1: Extend `TariffBody`**

Find the `TariffBody` type (around line 63) and add the new field:

```typescript
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
};
```

- [ ] **Step 2: Pass `is_test_shop` into the activate branch**

Find the activate branch's call to `ensurePendingInvoiceForTariff` (around line 215). Replace the surrounding block:

```typescript
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
```

- [ ] **Step 3: Pass `is_test_shop` into the extend branch**

Find the extend branch's call (around line 304). Replace:

```typescript
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
```

- [ ] **Step 4: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/api/admin/users/[id]/tariff/route.ts
git commit -m "feat(admin-tariff): accept is_test_shop for autopayment activate/extend"
```

---

## Task 5: Invoices POST accepts `is_test_shop`

**Files:**
- Modify: `app/src/app/api/invoices/route.ts`

- [ ] **Step 1: Extend the request body type and pull the flag**

In `app/src/app/api/invoices/route.ts`, replace the `body` typing in the POST handler (around line 154) and the validation block right after:

```typescript
  let body: {
    company_name: string;
    amount: number;
    currency?: string;
    description?: string;
    client_user_id?: string;
    vat_code?: number;
    is_test_shop?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  if (!body.company_name?.trim()) return jsonError('company_name is required', 400);
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return jsonError('amount must be positive', 400);

  const isTestShop = body.is_test_shop === true;
```

- [ ] **Step 2: Save `is_test_shop` on the INSERT**

Right below, find the INSERT (still around line 172). Add the new field:

```typescript
  const { data: invoice, error: insertError } = await supabaseAdmin
    .from('invoices')
    .insert({
      company_name: body.company_name.trim(),
      amount,
      currency: body.currency ?? 'RUB',
      description: body.description?.trim() ?? null,
      client_user_id: body.client_user_id ?? null,
      created_by: user.id,
      status: 'pending',
      is_test_shop: isTestShop,
    })
    .select()
    .single();
```

- [ ] **Step 3: Route the YK call to the right shop**

Replace the `isYookassaConfigured()` check and the `createYookassaInvoice` block (around lines 194–235). Both reads of process.env stay the same — only the calls change:

```typescript
  if (!isYookassaConfigured(isTestShop)) {
    yookassaError = isTestShop
      ? 'YOOKASSA_TEST_SHOP_ID / YOOKASSA_TEST_SECRET_KEY не настроены'
      : 'YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не настроены';
  } else {
    // ... (existing email-resolution block unchanged) ...
    let customerEmail: string | null = null;
    if (invoice.client_user_id) {
      const { data: clientProfile } = await supabaseAdmin
        .from('profiles')
        .select('email')
        .eq('id', invoice.client_user_id)
        .maybeSingle();
      customerEmail = clientProfile?.email ?? null;
    }
    if (!customerEmail) {
      customerEmail = process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL ?? null;
    }

    if (!customerEmail) {
      yookassaError = 'Не удалось определить email для чека (54-ФЗ). Привяжите клиента к счёту или задайте YOOKASSA_FALLBACK_RECEIPT_EMAIL.';
      await logError('invoices.yookassa.no_receipt_email', null, { invoice_id: invoice.id, client_user_id: invoice.client_user_id });
    } else {
      try {
        const description = invoice.description ?? `Счёт для ${invoice.company_name}`;
        const vatCode = (body.vat_code as YookassaVatCode | undefined) ?? 1;
        const ykInvoice = await createYookassaInvoice(
          {
            amount,
            currency: invoice.currency,
            description,
            invoiceId: invoice.id,
            companyName: invoice.company_name,
            idempotencyKey: invoice.id,
            receipt: buildDefaultReceipt({
              customerEmail,
              description,
              amount,
              currency: invoice.currency,
              vatCode,
            }),
          },
          isTestShop,
        );

        const ykUrl = extractInvoiceUrl(ykInvoice);

        await supabaseAdmin
          .from('invoices')
          .update({
            yookassa_payment_id: ykInvoice.id,
            yookassa_payment_url: ykUrl,
          })
          .eq('id', invoice.id);

        invoice.yookassa_payment_id = ykInvoice.id;
        invoice.yookassa_payment_url = ykUrl;
      } catch (ykErr) {
        yookassaError = ykErr instanceof Error ? ykErr.message : String(ykErr);
        await logError('invoices.yookassa.create.failed', ykErr, { invoice_id: invoice.id, is_test_shop: isTestShop });
      }
    }
  }
```

- [ ] **Step 4: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/api/invoices/route.ts
git commit -m "feat(invoices-api): accept is_test_shop on POST"
```

---

## Task 6: Invoices PATCH uses `existing.is_test_shop` for every YK call

**Files:**
- Modify: `app/src/app/api/invoices/[id]/route.ts`

- [ ] **Step 1: Use the saved flag in the archive (cancel-in-YK) branch**

Find the archive block (around line 93) and replace the two lines that touch YK:

```typescript
  if (body.archive) {
    const isTestShop = existing.is_test_shop === true;
    if (existing.yookassa_payment_id && existing.status === 'pending' && isYookassaConfigured(isTestShop)) {
      try {
        await cancelYookassaInvoice(existing.yookassa_payment_id, isTestShop);
      } catch (ykErr) {
        await logError('invoices.archive.yk_cancel.failed', ykErr, { id, yk_id: existing.yookassa_payment_id, is_test_shop: isTestShop });
      }
    }
```

- [ ] **Step 2: Use the saved flag in the `create_yookassa_payment` branch**

Find the block (around line 117) and replace the configured check and both YK calls in it:

```typescript
  if (body.create_yookassa_payment) {
    const isTestShop = existing.is_test_shop === true;
    if (!isYookassaConfigured(isTestShop)) {
      return jsonError(
        isTestShop
          ? 'YOOKASSA_TEST_SHOP_ID / YOOKASSA_TEST_SECRET_KEY не настроены'
          : 'YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не настроены',
        503,
      );
    }
    try {
      if (existing.yookassa_payment_url) {
        return NextResponse.json({ invoice: existing });
      }

      if (existing.yookassa_payment_id && !existing.yookassa_payment_url) {
        const ykInvoice = await getYookassaInvoice(existing.yookassa_payment_id, isTestShop);
        const ykUrl = extractInvoiceUrl(ykInvoice);
        if (ykUrl) {
          await supabaseAdmin.from('invoices').update({ yookassa_payment_url: ykUrl }).eq('id', id);
        }
        await logAudit('invoices.yk_url_recovered', `YK URL recovered for ${id}`, { id, is_test_shop: isTestShop }, { userId: user.id });
        const { data: recovered } = await supabaseAdmin.from('invoices').select('*').eq('id', id).single();
        return NextResponse.json({ invoice: recovered });
      }

      // No YK invoice yet — create it.
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
      const ykInvoice = await createYookassaInvoice(
        {
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
        },
        isTestShop,
      );

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

      await logAudit('invoices.yk_invoice_created', `YK invoice created for ${id}`, { id, yk_id: ykInvoice.id, is_test_shop: isTestShop }, { userId: user.id });
      const { data: updatedAfterYk } = await supabaseAdmin.from('invoices').select('*').eq('id', id).single();
      return NextResponse.json({ invoice: updatedAfterYk });
    } catch (ykErr) {
      const msg = ykErr instanceof Error ? ykErr.message : String(ykErr);
      await logError('invoices.patch.yk_create.failed', ykErr, { id });
      return NextResponse.json({ error: `ЮКасса: ${msg}` }, { status: 502 });
    }
  }
```

- [ ] **Step 3: Use the saved flag in the `sync_yookassa` branch**

Find the block (around line 199) and replace the `getYookassaInvoice` call:

```typescript
  if (body.sync_yookassa && existing.yookassa_payment_id) {
    const isTestShop = existing.is_test_shop === true;
    try {
      const ykInvoice = await getYookassaInvoice(existing.yookassa_payment_id, isTestShop);
      // ... rest of the block unchanged ...
```

(Leave the rest of the sync block untouched — it's about local DB state, not YK creds.)

- [ ] **Step 4: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/api/invoices/[id]/route.ts
git commit -m "feat(invoices-api): use saved is_test_shop for every YK call on PATCH"
```

---

## Task 7: Auto-renew cron passes `is_test_shop`

**Files:**
- Modify: `app/src/app/api/cron/auto-renew/route.ts`

- [ ] **Step 1: Add `is_test_shop` to the SELECT**

In `app/src/app/api/cron/auto-renew/route.ts`, find the supabase fetch (around line 44). Append the column:

```typescript
  const { data: due, error: fetchErr } = await supabaseAdmin
    .from('client_tariffs')
    .select('id, user_id, tariff_type, paid_until, yookassa_payment_method_id, billing_mode, billing_period, billing_amount, is_test_shop')
    .eq('auto_renew', true)
    .eq('is_active', true)
    .eq('billing_mode', 'autopayment')
    .not('yookassa_payment_method_id', 'is', null)
    .lte('paid_until', renewBefore.toISOString());
```

- [ ] **Step 2: Pass the field into `chargeMonthlyRenewal`**

Find the `for (const row of due ?? [])` loop. Add `is_test_shop` to the row mapping:

```typescript
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
    });

    results.push({
      user_id: row.user_id,
      invoice_id: renewal.invoiceId,
      success: renewal.success,
      ...(renewal.errorRu ? { error: renewal.errorRu } : {}),
    });
  }
```

Note: the top-level `isYookassaConfigured()` guard on line 37 stays — it's just a sanity check that the production env is set; per-row credential selection happens inside `chargeMonthlyRenewal`.

- [ ] **Step 3: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: SUCCESS.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/api/cron/auto-renew/route.ts
git commit -m "feat(cron-renew): pass is_test_shop into chargeMonthlyRenewal"
```

---

## Task 8: Webhook doc comment about shared endpoint

**Files:**
- Modify: `app/src/app/api/invoices/webhook/route.ts`

- [ ] **Step 1: Update the file-level JSDoc**

Find the JSDoc at the top of `app/src/app/api/invoices/webhook/route.ts` (around line 11). Add a paragraph about test-shop notifications. Replace the entire JSDoc with:

```typescript
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
 * Multi-shop note: both the production and test YooKassa shops are configured
 * to POST to this same endpoint. We disambiguate by the UUID `payment_id` —
 * unique across shops in practice — and never touch the YK API from inside
 * the webhook handler, so no shop-specific credentials are needed here. The
 * test shop's webhook URL must be configured separately in the YooKassa test
 * cabinet, pointing to this same path.
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
```

- [ ] **Step 2: Commit**

```bash
git add app/src/app/api/invoices/webhook/route.ts
git commit -m "docs(webhook): note shared endpoint serves both YK shops"
```

---

## Task 9: SubscriptionPanel UI — "Магазин YooKassa" toggle

**Files:**
- Modify: `app/src/app/admin/users/page.tsx`

- [ ] **Step 1: Add `useTestShop` state and reset it in extend mode**

In `SubscriptionPanel` (defined around line 270), the existing useState block looks like:

```typescript
  const [activateBillingMode, setActivateBillingMode] = useState<'invoice' | 'autopayment' | 'manual'>('manual');
  const [activatePeriod, setActivatePeriod] = useState<'month' | 'half_year' | 'year'>('month');
  const [activateCustomAmount, setActivateCustomAmount] = useState('');
  const [activating, setActivating] = useState(false);
  const [showExtendForm, setShowExtendForm] = useState(false);
```

Add one more line:

```typescript
  const [useTestShop, setUseTestShop] = useState(false);
```

In the "Продлить подписку" button handler (around line 559), where it currently resets `activatePeriod` and `activateCustomAmount`, also reset the test-shop flag:

```typescript
          {subscriptionActive && !showExtendForm && (
            <button
              type="button"
              disabled={activating}
              onClick={() => {
                setActivatePeriod('month');
                setActivateCustomAmount('');
                setUseTestShop(false);
                setShowExtendForm(true);
              }}
              // ... rest unchanged
```

- [ ] **Step 2: Send `is_test_shop` in `handleActivate`**

Find the `handleActivate` body inside `apiFetch` (around line 296). The JSON body becomes:

```typescript
        body: JSON.stringify({
          action: 'activate',
          billing_mode: bm,
          tariff_type: tariffType,
          billing_period: activatePeriod,
          billing_amount: customAmt,
          is_test_shop: bm === 'autopayment' ? useTestShop : false,
        }),
```

Also add `useTestShop` to the dependency array of the `useCallback` at the end of `handleActivate`:

```typescript
  }, [activateBillingMode, activatePeriod, activateCustomAmount, tariffType, userId, apiFetch, onActivateResult, onSuccessMessage, onError, useTestShop]);
```

- [ ] **Step 3: Send `is_test_shop` in `handleExtend`**

Find the `handleExtend` body (around line 393). Same change:

```typescript
        body: JSON.stringify({
          action: 'extend',
          billing_mode: bm,
          tariff_type: tariffType,
          billing_period: activatePeriod,
          billing_amount: customAmt,
          is_test_shop: bm === 'autopayment' ? useTestShop : false,
        }),
```

And update its dependency array:

```typescript
  }, [activateBillingMode, activatePeriod, activateCustomAmount, tariffType, userId, apiFetch, onExtendResult, onSuccessMessage, onError, useTestShop]);
```

- [ ] **Step 4: Render the toggle in the activate form (only when autopayment)**

In the activate form (the `{!subscriptionActive && !subscriptionSetup && (` block around line 460), find the row that renders the three billing-mode buttons (`manual`/`invoice`/`autopayment`) at around line 500. Right after that `<div className="flex gap-1.5 ...">` block closes, insert the new shop selector. The whole pattern becomes:

```tsx
            <div className="flex gap-1.5 min-[520px]:col-span-2">
              {(['manual', 'invoice', 'autopayment'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setActivateBillingMode(m)}
                  className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                    activateBillingMode === m
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {m === 'manual' ? 'Вручную' : m === 'invoice' ? '🧾 Счёт' : '💳 Автоплатёж'}
                </button>
              ))}
            </div>

            {activateBillingMode === 'autopayment' && (
              <div className="min-[520px]:col-span-2">
                <p className="mb-1.5 text-[11px] font-medium text-gray-700">Магазин YooKassa</p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setUseTestShop(false)}
                    className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                      !useTestShop
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                    }`}
                  >
                    Боевой
                  </button>
                  <button
                    type="button"
                    onClick={() => setUseTestShop(true)}
                    className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                      useTestShop
                        ? 'bg-yellow-500 text-white border-yellow-500'
                        : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                    }`}
                  >
                    🧪 Тестовый
                  </button>
                </div>
              </div>
            )}
```

- [ ] **Step 5: Render the same toggle in the extend form**

In the extend form (the `{subscriptionActive && showExtendForm && (` block around line 583), find the matching billing-mode row (around line 633). Insert the same toggle right after:

```tsx
          <div className="mt-2 flex gap-1.5">
            {(['manual', 'invoice', 'autopayment'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setActivateBillingMode(m)}
                className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                  activateBillingMode === m
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                }`}
              >
                {m === 'manual' ? 'Вручную' : m === 'invoice' ? '🧾 Счёт' : '💳 Автоплатёж'}
              </button>
            ))}
          </div>

          {activateBillingMode === 'autopayment' && (
            <div className="mt-2">
              <p className="mb-1.5 text-[11px] font-medium text-gray-700">Магазин YooKassa</p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setUseTestShop(false)}
                  className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                    !useTestShop
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                  }`}
                >
                  Боевой
                </button>
                <button
                  type="button"
                  onClick={() => setUseTestShop(true)}
                  className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                    useTestShop
                      ? 'bg-yellow-500 text-white border-yellow-500'
                      : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                  }`}
                >
                  🧪 Тестовый
                </button>
              </div>
            </div>
          )}
```

- [ ] **Step 6: Type-check and lint**

Run: `cd app && npx tsc --noEmit && npm run lint`
Expected: SUCCESS.

- [ ] **Step 7: Commit**

```bash
git add app/src/app/admin/users/page.tsx
git commit -m "feat(admin-users): YooKassa shop toggle in subscription panel"
```

---

## Task 10: CreateModal (Invoices page) — toggle

**Files:**
- Modify: `app/src/app/invoices/InvoicesPageView.tsx`

- [ ] **Step 1: Add the `is_test_shop` field to the `Invoice` interface**

At the top of the file (around line 17), update the `Invoice` interface:

```typescript
interface Invoice {
  id: string;
  company_name: string;
  client_user_id: string | null;
  amount: number;
  currency: string;
  description: string | null;
  status: InvoiceStatus;
  yookassa_payment_id: string | null;
  yookassa_payment_url: string | null;
  is_test_shop: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  creator?: { id: string; full_name: string; email: string } | null;
}
```

- [ ] **Step 2: Add `useTestShop` state inside `CreateModal`**

Find the state declarations at the top of `CreateModal` (around line 187):

```typescript
function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const [companyName, setCompanyName] = useState('');
  const [clientUserId, setClientUserId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('RUB');
  const [description, setDescription] = useState('');
  const [useTestShop, setUseTestShop] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
```

- [ ] **Step 3: Send `is_test_shop` in the POST body**

In `handleSubmit` (around line 272), update the fetch body:

```typescript
      const res = await authFetch('/api/invoices', {
        method: 'POST',
        body: JSON.stringify({
          company_name: companyName.trim(),
          amount: amt,
          currency,
          description: description.trim() || undefined,
          client_user_id: clientUserId ?? undefined,
          vat_code: 1,
          is_test_shop: useTestShop,
        }),
      });
```

And update the `useCallback` dependency array at the end of `handleSubmit`:

```typescript
  }, [companyName, clientUserId, amount, currency, description, useTestShop, onCreated, onClose]);
```

- [ ] **Step 4: Render the toggle inside the modal**

Find the «Назначение платежа» field block (around line 412) — the one with `<label className="block text-xs font-medium text-zinc-600 mb-1">Назначение платежа *</label>`. Right after the closing `</div>` of that block (just before the `{error && (...)` block), insert the new toggle:

```tsx
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">Магазин YooKassa</label>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setUseTestShop(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                  !useTestShop
                    ? 'bg-zinc-900 text-white border-zinc-900'
                    : 'border-zinc-200 text-zinc-600 bg-white hover:bg-zinc-50'
                }`}
              >
                Боевой
              </button>
              <button
                type="button"
                onClick={() => setUseTestShop(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                  useTestShop
                    ? 'bg-yellow-500 text-white border-yellow-500'
                    : 'border-zinc-200 text-zinc-600 bg-white hover:bg-zinc-50'
                }`}
              >
                🧪 Тестовый
              </button>
            </div>
          </div>
```

- [ ] **Step 5: Type-check and lint**

Run: `cd app && npx tsc --noEmit && npm run lint`
Expected: SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add app/src/app/invoices/InvoicesPageView.tsx
git commit -m "feat(invoices-ui): YooKassa shop toggle in CreateModal"
```

---

## Task 11: Invoices table — yellow «🧪 Тест» badge

**Files:**
- Modify: `app/src/app/invoices/InvoicesPageView.tsx`

- [ ] **Step 1: Render the badge next to the status pill**

Find the table row that renders status (around line 867):

```tsx
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[inv.status]}`}>
                        {STATUS_LABEL[inv.status]}
                      </span>
                    </td>
```

Replace it with:

```tsx
                    <td className="px-4 py-3 text-center">
                      <div className="inline-flex items-center gap-1">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[inv.status]}`}>
                          {STATUS_LABEL[inv.status]}
                        </span>
                        {inv.is_test_shop && (
                          <span
                            className="inline-flex items-center rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700"
                            title="Счёт создан в тестовом магазине YooKassa"
                          >
                            🧪 Тест
                          </span>
                        )}
                      </div>
                    </td>
```

- [ ] **Step 2: Type-check and lint**

Run: `cd app && npx tsc --noEmit && npm run lint`
Expected: SUCCESS.

- [ ] **Step 3: Commit**

```bash
git add app/src/app/invoices/InvoicesPageView.tsx
git commit -m "feat(invoices-ui): yellow «Тест» badge for test-shop invoices"
```

---

## Task 12: End-to-end manual verification

This is a non-code task — verify the full flow on the local dev server. None of the previous tasks exercises a real YooKassa call together with a real DB write.

- [ ] **Step 1: Set test creds in `.env`**

Append to `.env` (already gitignored):

```
YOOKASSA_TEST_SHOP_ID=<the test shop id from YooKassa test cabinet>
YOOKASSA_TEST_SECRET_KEY=<the test secret from YooKassa test cabinet>
```

Restart `npm run dev` so Next.js picks up the new env.

- [ ] **Step 2: Verify the production path is unchanged**

1. Open `/invoices`, click «Выставить счёт».
2. Pick a client with a known email, default «Боевой» selected.
3. Submit. Expected: invoice row appears with no `🧪 Тест` badge; YK creates a real invoice with the production shop credentials; the QR modal opens with a `yookassa.ru/...` URL that requires real payment.
4. Archive the invoice to clean up — expected: YK invoice is cancelled.

- [ ] **Step 3: Verify the test-shop path**

1. Repeat step 2 but flip to «🧪 Тестовый».
2. Submit. Expected: invoice row shows a yellow `🧪 Тест` badge next to its status; YK call uses the test creds (you should see the invoice show up in your YooKassa test-shop dashboard, not the production one).
3. Open the payment URL in an incognito tab, pay with a YooKassa test card (`5555 5555 5555 4444`, any future expiry, any CVC). Expected: webhook fires, invoice flips to «Оплачен», client tariff unlocks.

- [ ] **Step 4: Verify the admin autopayment path**

1. In `/admin/users`, edit a test user, set up `Стандарт` + month + `💳 Автоплатёж` + `🧪 Тестовый`.
2. Activate. Expected: success message mentions the test shop (or at least the autopayment success message appears); `/invoices` shows a new row with the yellow badge for this client; `client_tariffs.is_test_shop` is `true` for this user (verify with psql).
3. Deactivate the subscription afterwards.

- [ ] **Step 5: Verify the cron path manually**

In a psql shell, simulate a due test-shop renewal — find a row in `client_tariffs` where `is_test_shop=true`, set `paid_until` to `NOW()` so the cron's 24h window picks it up. Then hit `/api/cron/auto-renew?secret=$CRON_SECRET`. Expected: response shows a successful charge result for that user; the new invoice in `/invoices` is flagged test; no production-shop credentials are touched.

(Skip this step if you don't have a saved test card on file — the cron needs `yookassa_payment_method_id` populated, which only happens after a real test payment from step 3.)

- [ ] **Step 6: No commit — verification only**

If anything in steps 2–5 misbehaves, re-open the failing task above and fix.

---

## Self-Review

Checked against the spec:

- ✅ Migration adds `is_test_shop` to both `invoices` and `client_tariffs` (Task 1).
- ✅ `lib/yookassa.ts` refactored to per-call shop selection, lazy env reads, all 5 public functions take the flag (Task 2). Plus tests for `isYookassaConfigured`.
- ✅ `lib/billing.ts` — `EnsureInvoiceParams.isTestShop`, shop-switch logic in reuse path, writes flag into both tables, threads to `chargeMonthlyRenewal` (Task 3).
- ✅ Tariff PUT accepts and propagates the flag for activate + extend (Task 4).
- ✅ Invoices POST accepts and propagates (Task 5).
- ✅ Invoices PATCH reads from row, uses on archive/sync/recover/create (Task 6).
- ✅ Cron auto-renew selects and propagates (Task 7).
- ✅ Webhook gets a doc comment about the shared endpoint (Task 8).
- ✅ SubscriptionPanel UI gets the toggle, conditional on autopayment (Task 9).
- ✅ CreateModal gets the toggle (Task 10).
- ✅ Invoice table gets the yellow badge (Task 11).
- ✅ End-to-end manual verification (Task 12).

No placeholders. Method signatures consistent across tasks (`isTestShop` is always second positional arg on YK functions; `is_test_shop` is the column name everywhere; `useTestShop` is the React state name in both UI surfaces). The only spec requirement that intentionally isn't tested by automated tests is the orchestrator part of `billing.ts` — same convention as the existing test file. Task 12 covers it end-to-end.
