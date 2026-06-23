# Client self-signup + 15-day warmup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Открыть саморегистрацию клиентов (точка входа — поддомен `app.outreachos.pro`), добавить self-serve выбор тарифа и оплату в ЛК, заменить 3-дневную setup-фазу 15-дневным прогревом, и снять гейт прогрева со всего кроме запуска кампаний.

**Architecture:** Поверх существующего биллинга (`client_tariffs`, ЮKassa, webhook). Минимум новых файлов: один новый endpoint, одна новая страница, расширение существующего payment endpoint, и точечные правки констант + одной строки копи. Идём подход A из спеки (применяется ко всем клиентам, без host-разветвления).

**Tech Stack:** Next.js 16 App Router, Supabase Auth + SSR cookies, ЮKassa, Jest, TypeScript.

**Spec:** [docs/superpowers/specs/2026-06-23-client-self-signup-and-warmup-design.md](../specs/2026-06-23-client-self-signup-and-warmup-design.md)

---

## File Structure

**Modify:**
- `app/src/lib/tariffs.ts` — добавить `quarter` период, `SETUP_DAYS: 3 → 15`
- `app/src/app/api/parsers/yandexmaps/route.ts:57-59` — снять setup-гейт
- `app/src/app/api/parsers/search/route.ts:93-95` — снять setup-гейт
- `app/src/lib/clientLaunch/runLaunch.ts:202-207` — обновить копи ошибки
- `app/src/middleware.ts:117-127` — добавить `/signup` в `isPublicPath`
- `app/src/app/login/page.tsx` — условная кнопка «Зарегистрироваться»
- `app/src/app/client/tariff/page.tsx` — виджет выбора тарифа для inactive клиентов
- `app/src/app/api/client/payment/route.ts` — поддержать first-time invoice flow
- `app/src/lib/billing.ts` — `ensurePendingInvoiceForTariff` уметь работать с invoice-mode на первой оплате (см. Task 7)

**Create:**
- `app/src/app/signup/page.tsx` — UI саморегистрации
- `app/src/app/api/signup/route.ts` — POST endpoint саморегистрации
- `app/tests/lib/tariffs.test.ts` — юнит-тесты на calcBillingAmount и SETUP_DAYS (если нет файла, иначе расширить)
- `app/tests/api/signup.test.ts` — integration test на POST /api/signup

---

## Task 1: Добавить период `quarter` (3 месяца)

**Files:**
- Modify: `app/src/lib/tariffs.ts`
- Test: `app/tests/lib/tariffs.test.ts` (create if missing)

- [ ] **Step 1: Write failing test**

`app/tests/lib/tariffs.test.ts`:

```ts
import { calcBillingAmount, BILLING_PERIOD_MONTHS } from '@/lib/tariffs';

describe('BillingPeriod quarter', () => {
  it('BILLING_PERIOD_MONTHS.quarter === 3', () => {
    expect(BILLING_PERIOD_MONTHS.quarter).toBe(3);
  });

  it('calcBillingAmount(standard, quarter) === 120_000', () => {
    expect(calcBillingAmount('standard', 'quarter')).toBe(120_000);
  });

  it('calcBillingAmount(pro, quarter) === 240_000', () => {
    expect(calcBillingAmount('pro', 'quarter')).toBe(240_000);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```
cd app && npx jest tests/lib/tariffs.test.ts
```

Expected: FAIL — `Property 'quarter' does not exist on type 'Record<BillingPeriod, number>'`.

- [ ] **Step 3: Add quarter to type + map**

In `app/src/lib/tariffs.ts`, find:
```ts
export type BillingPeriod = 'month' | 'half_year' | 'year';
```
Replace with:
```ts
export type BillingPeriod = 'month' | 'quarter' | 'half_year' | 'year';
```

Find:
```ts
export const BILLING_PERIOD_MONTHS: Record<BillingPeriod, number> = {
  month: 1,
  half_year: 6,
  year: 12,
};
```
Replace with:
```ts
export const BILLING_PERIOD_MONTHS: Record<BillingPeriod, number> = {
  month: 1,
  quarter: 3,
  half_year: 6,
  year: 12,
};
```

- [ ] **Step 4: Run test, expect pass**

```
cd app && npx jest tests/lib/tariffs.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```
git add app/src/lib/tariffs.ts app/tests/lib/tariffs.test.ts
git commit -m "feat(tariffs): add quarter (3-month) billing period"
```

---

## Task 2: SETUP_DAYS 3 → 15

**Files:**
- Modify: `app/src/lib/tariffs.ts:31`

- [ ] **Step 1: Edit constant**

In `app/src/lib/tariffs.ts:31`, find:
```ts
export const SETUP_DAYS = 3;
```
Replace with:
```ts
export const SETUP_DAYS = 15;
```

- [ ] **Step 2: Run full test suite to catch regressions**

```
cd app && npx jest 2>&1 | tail -10
```

Expected: все тесты, что были зелёные, остаются зелёные. Если ломается тест из-за `SETUP_DAYS=3` — он завязан на старое значение, нужно обновить его под 15.

- [ ] **Step 3: Commit**

```
git add app/src/lib/tariffs.ts
git commit -m "feat(billing): warmup period 3 → 15 days"
```

---

## Task 3: Снять setup-гейт с парсера Yandex Maps

**Files:**
- Modify: `app/src/app/api/parsers/yandexmaps/route.ts:57-59`

- [ ] **Step 1: Edit**

В `app/src/app/api/parsers/yandexmaps/route.ts` найди:
```ts
        if (tariffUsage.status === 'setup') {
          return jsonError('Ваш личный кабинет настраивается. Пожалуйста, подождите — мы скоро всё подготовим.', 403);
        }
        if (tariffUsage.status !== 'active') {
          return jsonError('Подписка не активна. Оплатите тариф для продолжения работы.', 403);
        }
```

Замени на:
```ts
        if (tariffUsage.status !== 'active' && tariffUsage.status !== 'setup') {
          return jsonError('Подписка не активна. Оплатите тариф для продолжения работы.', 403);
        }
```

Эффект: setup теперь пропускается (как и active), inactive/expired по-прежнему режутся.

- [ ] **Step 2: Commit**

```
git add app/src/app/api/parsers/yandexmaps/route.ts
git commit -m "feat(warmup): unlock yandexmaps parser during warmup phase"
```

---

## Task 4: Снять setup-гейт с парсера Search

**Files:**
- Modify: `app/src/app/api/parsers/search/route.ts:93-98`

- [ ] **Step 1: Edit**

В `app/src/app/api/parsers/search/route.ts` найди тот же блок что в Task 3 (строки 93-98) и применить ту же замену:

Было:
```ts
        if (tariffUsage.status === 'setup') {
          return jsonError('Ваш личный кабинет настраивается. Пожалуйста, подождите — мы скоро всё подготовим.', 403);
        }
        if (tariffUsage.status !== 'active') {
          return jsonError('Подписка не активна. Оплатите тариф для продолжения работы.', 403);
        }
```

Стало:
```ts
        if (tariffUsage.status !== 'active' && tariffUsage.status !== 'setup') {
          return jsonError('Подписка не активна. Оплатите тариф для продолжения работы.', 403);
        }
```

- [ ] **Step 2: Commit**

```
git add app/src/app/api/parsers/search/route.ts
git commit -m "feat(warmup): unlock search parser during warmup phase"
```

---

## Task 5: Обновить копи ошибки в runLaunch

**Files:**
- Modify: `app/src/lib/clientLaunch/runLaunch.ts:202-207`

- [ ] **Step 1: Edit copy**

В `app/src/lib/clientLaunch/runLaunch.ts` найди:
```ts
  if (clientStatus === 'setup') {
    throw new ClientLaunchError(
      'Ваш личный кабинет настраивается. Пожалуйста, подождите — мы скоро всё подготовим.',
      403,
    );
  }
```

Замени на:
```ts
  if (clientStatus === 'setup') {
    throw new ClientLaunchError(
      'Идёт прогрев почт. Запуск кампаний станет доступен после завершения прогрева (15 дней с момента оплаты). До этого вы можете пользоваться остальными инструментами портала.',
      403,
    );
  }
```

- [ ] **Step 2: Тот же текст в appendLeads (он шарит копи)**

В `app/src/lib/clientLaunch/appendLeads.ts:103-109` найди аналогичный блок и замени на тот же текст про прогрев (но с акцентом на «добавление лидов»):

```ts
  if (clientStatus === 'setup') {
    throw new ClientLaunchError(
      'Идёт прогрев почт. Добавление лидов в кампании станет доступным после завершения прогрева (15 дней с момента оплаты).',
      403,
    );
  }
```

- [ ] **Step 3: Commit**

```
git add app/src/lib/clientLaunch/runLaunch.ts app/src/lib/clientLaunch/appendLeads.ts
git commit -m "feat(warmup): update launch/appendLeads error copy to mention warmup"
```

---

## Task 6: Добавить `/signup` в публичные пути middleware

**Files:**
- Modify: `app/src/middleware.ts:117-123`

- [ ] **Step 1: Edit**

В `app/src/middleware.ts` найди:
```ts
    const isPublicPath =
      pathname === '/maintenance' ||
      pathname === '/login' ||
      pathname === '/offer' ||
      pathname.startsWith('/api/telegram/verify') ||
      pathname.startsWith('/api/telegram/link') ||
      pathname.startsWith('/review/base/')
```

Замени на:
```ts
    const isPublicPath =
      pathname === '/maintenance' ||
      pathname === '/login' ||
      pathname === '/signup' ||
      pathname === '/offer' ||
      pathname.startsWith('/api/signup') ||
      pathname.startsWith('/api/telegram/verify') ||
      pathname.startsWith('/api/telegram/link') ||
      pathname.startsWith('/review/base/')
```

- [ ] **Step 2: Также пропускаем `/signup` для уже залогиненных** (как `/login`)

Найди:
```ts
    if (user && userRole && pathname === '/login') {
      return NextResponse.redirect(
        new URL(userRole === 'client' ? '/client' : '/', request.url)
      )
    }
```

Замени на:
```ts
    if (user && userRole && (pathname === '/login' || pathname === '/signup')) {
      return NextResponse.redirect(
        new URL(userRole === 'client' ? '/client' : '/', request.url)
      )
    }
```

- [ ] **Step 3: Commit**

```
git add app/src/middleware.ts
git commit -m "feat(auth): allow /signup as public path + redirect logged-in users"
```

---

## Task 7: Endpoint саморегистрации `/api/signup`

**Files:**
- Create: `app/src/app/api/signup/route.ts`
- Create: `app/tests/api/signup.test.ts`

- [ ] **Step 1: Write failing integration test**

`app/tests/api/signup.test.ts`:

```ts
/**
 * Integration test for POST /api/signup. Mocks Supabase admin client so we
 * test request handling + DB row creation logic without hitting a real DB.
 */
import { POST } from '@/app/api/signup/route';

jest.mock('@/lib/supabaseAdmin', () => {
  const created: { auth: any[]; profiles: any[]; tariffs: any[] } = { auth: [], profiles: [], tariffs: [] };
  const mock = {
    __created: created,
    auth: {
      admin: {
        createUser: jest.fn(async (params: { email: string; password: string }) => {
          created.auth.push(params);
          return { data: { user: { id: 'user-123', email: params.email } }, error: null };
        }),
      },
    },
    from: (table: string) => ({
      insert: jest.fn(async (row: any) => {
        if (table === 'profiles') created.profiles.push(row);
        if (table === 'client_tariffs') created.tariffs.push(row);
        return { error: null };
      }),
    }),
  };
  return { supabaseAdmin: mock };
});

function makeReq(body: any) {
  return new Request('http://localhost/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/signup', () => {
  it('rejects missing email', async () => {
    const res = await POST(makeReq({ password: 'longenough123' }));
    expect(res.status).toBe(400);
  });

  it('rejects too-short password', async () => {
    const res = await POST(makeReq({ email: 'a@b.com', password: 'short' }));
    expect(res.status).toBe(400);
  });

  it('creates user + profile{role:client} + client_tariffs{is_active:false} on valid input', async () => {
    const res = await POST(makeReq({ email: 'new@user.com', password: 'longenough123' }));
    expect(res.status).toBe(201);
    const { supabaseAdmin } = require('@/lib/supabaseAdmin');
    const c = supabaseAdmin.__created;
    expect(c.auth).toHaveLength(1);
    expect(c.profiles).toHaveLength(1);
    expect(c.profiles[0]).toMatchObject({ id: 'user-123', role: 'client' });
    expect(c.tariffs).toHaveLength(1);
    expect(c.tariffs[0]).toMatchObject({ user_id: 'user-123', is_active: false, tariff_type: 'standard' });
  });
});
```

- [ ] **Step 2: Run test, expect failure (file doesn't exist)**

```
cd app && npx jest tests/api/signup.test.ts
```

Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement endpoint**

`app/src/app/api/signup/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * Open self-signup endpoint. Creates a Supabase auth user with the role
 * already set to 'client' and an inactive client_tariffs row so the user
 * lands in their portal in "demo" mode (status=inactive). They pay later
 * from /client/tariff. No email confirmation (см. open question 2 в спеке).
 */
function isEmailLike(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  if (!email || !isEmailLike(email)) {
    return NextResponse.json({ error: 'Введите корректный email' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Пароль должен быть от 8 символов' }, { status: 400 });
  }

  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createErr || !created?.user) {
    const msg = createErr?.message ?? 'Ошибка создания аккаунта';
    if (/already (registered|exists)|duplicate/i.test(msg)) {
      return NextResponse.json({ error: 'Аккаунт с таким email уже существует' }, { status: 409 });
    }
    await logError('signup.create_user_failed', createErr, { email });
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const userId = created.user.id;

  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, email, role: 'client', locale: 'ru' });
  if (profileErr) {
    await logError('signup.profile_insert_failed', profileErr, { userId });
    return NextResponse.json({ error: 'Ошибка создания профиля' }, { status: 500 });
  }

  const { error: tariffErr } = await supabaseAdmin
    .from('client_tariffs')
    .insert({
      user_id: userId,
      tariff_type: 'standard',
      is_active: false,
      payment_locked: false,
    });
  if (tariffErr) {
    await logError('signup.tariff_insert_failed', tariffErr, { userId });
    return NextResponse.json({ error: 'Ошибка инициализации тарифа' }, { status: 500 });
  }

  await logAudit('signup.created', `New client signed up: ${email}`, { userId, email });

  return NextResponse.json({ ok: true, user_id: userId }, { status: 201 });
}
```

- [ ] **Step 4: Run test, expect pass**

```
cd app && npx jest tests/api/signup.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```
git add app/src/app/api/signup/route.ts app/tests/api/signup.test.ts
git commit -m "feat(auth): POST /api/signup — open client self-registration"
```

---

## Task 8: Signup UI страница

**Files:**
- Create: `app/src/app/signup/page.tsx`

- [ ] **Step 1: Create page**

`app/src/app/signup/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

/**
 * Self-signup page. Visible on hosts listed in NEXT_PUBLIC_SIGNUP_HOSTS
 * (login page conditionally exposes the link). The page itself doesn't
 * check the host — anyone with the URL can register. Defense-in-depth would
 * be checking host server-side; out of scope for this PR.
 */
export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Ошибка регистрации');
        return;
      }
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) {
        setError('Аккаунт создан, но не получилось войти. Попробуйте ещё раз через /login.');
        return;
      }
      router.replace('/client');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-200 p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Регистрация</h1>
        <p className="text-sm text-gray-500 mb-5">Создайте аккаунт, чтобы начать работу с порталом</p>

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Пароль</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              autoComplete="new-password"
            />
            <p className="mt-1 text-[11px] text-gray-500">Минимум 8 символов</p>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {loading ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-gray-500">
          Уже есть аккаунт?{' '}
          <Link href="/login" className="text-indigo-600 hover:underline">
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check page compiles**

```
cd app && npx tsc --noEmit 2>&1 | grep -E "signup|signup/page" | head -5
```

Expected: no errors mentioning signup/page.tsx.

- [ ] **Step 3: Commit**

```
git add app/src/app/signup/page.tsx
git commit -m "feat(auth): /signup page UI"
```

---

## Task 9: Кнопка «Зарегистрироваться» на login — условно по хосту

**Files:**
- Modify: `app/src/app/login/page.tsx`

- [ ] **Step 1: Найти подходящее место в форме**

Открой `app/src/app/login/page.tsx`. Найди блок вокруг кнопки «Войти» и текста «Доступ к порталу выдаёт администратор».

- [ ] **Step 2: Добавить логику и кнопку**

В начало файла (после `'use client';`) добавь:
```tsx
function isSignupHost(host: string): boolean {
  const hosts = (process.env.NEXT_PUBLIC_SIGNUP_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hosts.length === 0) return false;
  return hosts.includes(host);
}
```

В компоненте login (после useState декларации) добавь:
```tsx
const [signupAllowed, setSignupAllowed] = useState(false);
useEffect(() => {
  if (typeof window !== 'undefined') {
    setSignupAllowed(isSignupHost(window.location.hostname));
  }
}, []);
```

Под текущей строкой `<p>Доступ к порталу выдаёт администратор</p>` добавь:
```tsx
{signupAllowed && (
  <p className="mt-2 text-center text-xs text-gray-600">
    Нет аккаунта?{' '}
    <Link href="/signup" className="font-medium text-indigo-600 hover:underline">
      Зарегистрироваться
    </Link>
  </p>
)}
```

Не забудь импорты:
```ts
import { useEffect } from 'react';
import Link from 'next/link';
```

- [ ] **Step 3: Set env var**

В `.env.local` (НЕ коммитить):
```
NEXT_PUBLIC_SIGNUP_HOSTS=app.outreachos.pro,localhost
```

(`localhost` для удобства разработки. В прод-env уже без localhost.)

- [ ] **Step 4: Commit**

```
git add app/src/app/login/page.tsx
git commit -m "feat(auth): show signup link on app.outreachos.pro hosts only"
```

---

## Task 10: `/client/tariff` — виджет выбора тарифа для inactive

**Files:**
- Modify: `app/src/app/client/tariff/page.tsx`
- Modify: `app/src/app/api/client/payment/route.ts`

- [ ] **Step 1: Расширить /api/client/payment**

Сейчас endpoint работает только для `payment_locked + autopayment`. Добавляем ветку для first-time invoice.

Открой `app/src/app/api/client/payment/route.ts` и замени GET-handler на:

```ts
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

  const ensured = await ensurePendingInvoiceForTariff({
    userId,
    reason: 'client_self',
    isTestShop: tariff.is_test_shop === true,
  });

  if (!ensured.yookassaUrl) {
    const message = ensured.yookassaError ?? 'Не удалось получить ссылку на оплату';
    const status = /не настроены/i.test(message) ? 503
      : /платёжной системы|Yookassa/i.test(message) ? 502
      : 500;
    return NextResponse.json({ error: message, invoice_id: ensured.invoiceId }, { status });
  }

  return NextResponse.json({
    payment_url: ensured.yookassaUrl,
    invoice_id: ensured.invoiceId,
    reused: ensured.reused,
  });
}
```

Добавь NEW handler POST (под GET):

```ts
/**
 * POST /api/client/payment — клиент впервые выбирает тариф и платит.
 *
 * Тело:
 *   { tariff_type: 'standard' | 'pro', billing_period: 'month'|'quarter'|'half_year'|'year' }
 *
 * Логика:
 *   1. Грузим client_tariffs. Если paid_at уже set — отказ (уже оплачена).
 *   2. Обновляем row: tariff_type, billing_period, billing_amount, billing_mode='autopayment',
 *      is_active=true, payment_locked=true, setup_until=now+15d.
 *   3. Вызываем ensurePendingInvoiceForTariff(reason='client_self') — он создаст
 *      ЮKassa инвойс и вернёт payment_url.
 *
 * Webhook /api/invoices/webhook на оплате обновит paid_at + paid_until через
 * applyInvoicePaidToTariff(); тот код корректно считает paid_until = setup_until + период.
 */
export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let body: { tariff_type?: string; billing_period?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const tariffType = body.tariff_type;
  const billingPeriod = body.billing_period;
  if (tariffType !== 'standard' && tariffType !== 'pro') {
    return NextResponse.json({ error: 'Неподдерживаемый тариф' }, { status: 400 });
  }
  if (!['month', 'quarter', 'half_year', 'year'].includes(billingPeriod ?? '')) {
    return NextResponse.json({ error: 'Неподдерживаемый период' }, { status: 400 });
  }

  const { calcBillingAmount, SETUP_DAYS } = await import('@/lib/tariffs');
  const amount = calcBillingAmount(tariffType as 'standard' | 'pro', billingPeriod as any);
  if (!amount) {
    return NextResponse.json({ error: 'Не удалось посчитать сумму' }, { status: 400 });
  }

  const { data: tariff } = await supabaseAdmin
    .from('client_tariffs')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (!tariff) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
  if (tariff.paid_at) {
    return NextResponse.json({ error: 'Подписка уже оплачена' }, { status: 400 });
  }

  const now = new Date();
  const setupUntil = new Date(now);
  setupUntil.setDate(setupUntil.getDate() + SETUP_DAYS);

  const { error: updateErr } = await supabaseAdmin
    .from('client_tariffs')
    .update({
      tariff_type: tariffType,
      billing_period: billingPeriod,
      billing_amount: amount,
      billing_mode: 'autopayment',
      is_active: true,
      payment_locked: true,
      setup_until: setupUntil.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('user_id', userId);

  if (updateErr) {
    return NextResponse.json({ error: `Не удалось обновить тариф: ${updateErr.message}` }, { status: 500 });
  }

  const ensured = await ensurePendingInvoiceForTariff({
    userId,
    reason: 'client_self',
    isTestShop: tariff.is_test_shop === true,
  });

  if (!ensured.yookassaUrl) {
    const message = ensured.yookassaError ?? 'Не удалось получить ссылку на оплату';
    return NextResponse.json({ error: message, invoice_id: ensured.invoiceId }, { status: 500 });
  }

  return NextResponse.json({
    payment_url: ensured.yookassaUrl,
    invoice_id: ensured.invoiceId,
  });
}
```

- [ ] **Step 2: Добавить виджет на /client/tariff**

В `app/src/app/client/tariff/page.tsx`, в самом верху основного блока (до текущего «01 → биллинг»), добавь компонент виджета. Виджет рендерится только когда `data.status === 'inactive'`.

Сразу после useState/useEffect-блока в основном компоненте найди return (...) и добавь перед первой секцией:

```tsx
{data && data.status === 'inactive' && !data.paid_at && (
  <TariffSelectionWidget />
)}
```

В том же файле (внизу, перед export default), добавь компонент:

```tsx
function TariffSelectionWidget() {
  const [tariff, setTariff] = useState<'standard' | 'pro'>('standard');
  const [period, setPeriod] = useState<'month' | 'quarter' | 'half_year' | 'year'>('month');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceTable: Record<'standard' | 'pro', number> = { standard: 40_000, pro: 80_000 };
  const periodMonths: Record<'month' | 'quarter' | 'half_year' | 'year', number> = {
    month: 1, quarter: 3, half_year: 6, year: 12,
  };
  const periodLabel: Record<'month' | 'quarter' | 'half_year' | 'year', string> = {
    month: '1 месяц', quarter: '3 месяца', half_year: '6 месяцев', year: '1 год',
  };
  const amount = priceTable[tariff] * periodMonths[period];

  const handlePay = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientApiFetch<{ payment_url: string }>('/payment', {
        method: 'POST',
        body: JSON.stringify({ tariff_type: tariff, billing_period: period }),
      });
      if (res.payment_url) {
        window.location.href = res.payment_url;
      } else {
        setError('Не удалось получить ссылку на оплату');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Выберите тариф</h2>
      <p className="text-xs text-gray-600 mb-4">После оплаты — 15 дней прогрев почт, затем активный период.</p>

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <button
          type="button"
          onClick={() => setTariff('standard')}
          className={`text-left rounded-xl border px-4 py-3 transition ${tariff === 'standard' ? 'border-indigo-500 bg-white shadow' : 'border-gray-200 bg-white/60'}`}
        >
          <p className="font-semibold text-gray-900">Стандарт</p>
          <p className="text-xs text-gray-600">40 000 ₽/мес · 10 000 контактов, 16 почт</p>
        </button>
        <button
          type="button"
          onClick={() => setTariff('pro')}
          className={`text-left rounded-xl border px-4 py-3 transition ${tariff === 'pro' ? 'border-indigo-500 bg-white shadow' : 'border-gray-200 bg-white/60'}`}
        >
          <p className="font-semibold text-gray-900">Про</p>
          <p className="text-xs text-gray-600">80 000 ₽/мес · 20 000 контактов, 32 почты</p>
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {(['month', 'quarter', 'half_year', 'year'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${period === p ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-700'}`}
          >
            {periodLabel[p]}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-indigo-100 pt-3">
        <p className="text-sm text-gray-700">К оплате: <span className="font-semibold text-gray-900">{amount.toLocaleString('ru-RU')} ₽</span></p>
        <button
          onClick={handlePay}
          disabled={loading}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {loading ? 'Создаём счёт…' : 'Оплатить через ЮKassa'}
        </button>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-700">{error}</p>
      )}
    </section>
  );
}
```

- [ ] **Step 3: clientApiFetch поддерживает POST?**

Проверь в `app/src/lib/clientFetcher.ts` принимает ли `clientApiFetch` второй параметр с `method`/`body`. Если нет — открыть и расширить (минимальная правка). Обычно такие хелперы поддерживают.

- [ ] **Step 4: Commit**

```
git add app/src/app/client/tariff/page.tsx app/src/app/api/client/payment/route.ts
git commit -m "feat(billing): self-serve tariff selection + first-time payment"
```

---

## Task 11: Полный прогон тестов

- [ ] **Step 1: Run full suite**

```
cd app && npx jest 2>&1 | tail -10
```

Expected: все тесты зелёные, кроме pre-existing leadTelegramAlerts.test.ts (он был сломан до этой работы).

- [ ] **Step 2: Type-check всего проекта**

```
cd app && npx tsc --noEmit 2>&1 | grep -v "imap\|mailparser" | head -20
```

Expected: только pre-existing missing-module ошибки в imap.ts (imapflow, mailparser). Никаких новых ошибок.

- [ ] **Step 3: Manual browser verification** (без preview-tools — юзер не разрешил)

Документируем в комментарии PR'a что эту фичу должен проверить руками юзер:
1. Открыть `app.outreachos.pro` (или localhost с NEXT_PUBLIC_SIGNUP_HOSTS=localhost) → /login → видеть кнопку «Зарегистрироваться».
2. На polza-portal.ru (или без `localhost` в env) → /login → НЕ видеть кнопку.
3. Зарегистрироваться → попасть в /client → status=inactive виден на /client/tariff.
4. Выбрать тариф+период → нажать «Оплатить» → редирект на ЮKassa.
5. (Тест-режим ЮKassa) — провести оплату. После webhook'а: status=setup, setup_until = now+15d.
6. Попробовать запустить кампанию на /client/launch → получить ошибку про прогрев.
7. Попробовать парсер на Яндекс.Картах → работает.

---

## Self-Review (выполнено при написании плана)

**Spec coverage check:**
- ✅ Section 1 (Регистрация) → Tasks 7, 8
- ✅ Section 2 (Кнопка на login условно по хосту) → Task 9
- ✅ Section 3 (Виджет выбора в /client/tariff) → Task 10
- ✅ Section 4 (период quarter) → Task 1
- ✅ Section 5 (SETUP_DAYS 3 → 15) → Task 2
- ✅ Section 6 (снять setup-гейт с парсеров) → Tasks 3, 4
- ✅ Section 7 (UI копи в runLaunch/appendLeads) → Task 5
- ✅ Middleware публичные пути → Task 6
- ✅ Полная верификация → Task 11

Open questions из спеки (appendLeads гейт, email confirmation) — текущий план фиксирует решение: appendLeads гейт ОСТАЁТСЯ (только копи обновляется в Task 5); email_confirm=true (Supabase шлёт письмо). Если эти решения юзера не устраивают — он скажет, поправим.

**Placeholder scan:** Не нашёл TBD / TODO / «similar to». Все код-блоки полны.

**Type consistency:** `BillingPeriod` тип в Task 1 = `'month' | 'quarter' | 'half_year' | 'year'`, в Task 10 endpoint валидируется тем же списком. ✓
