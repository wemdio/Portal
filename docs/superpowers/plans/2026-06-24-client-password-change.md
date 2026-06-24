# Client password change — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать клиенту возможность сменить пароль из ЛК Portal — самостоятельно вводит/генерирует новый пароль, получает на email-аккаунта письмо-уведомление (с указанием нового пароля для подсказки на случай забывания).

**Architecture:**
- UI: новая страница `/client/settings` (пункт «Настройки» в сайдбаре снизу рядом с Support/Offer). Форма из 3 полей с кнопкой «Сгенерировать» и toggle visibility.
- API: один POST-роут `/api/client/password` под client bearer-токеном. Re-auth текущего пароля → `supabase.auth.admin.updateUserById()` → отправка письма через Brevo HTTPS API → audit log.
- Email: транзакционный сервис **Brevo** (free tier 300 писем/день), вызов через `https://api.brevo.com/v3/smtp/email` (HTTPS, не SMTP — порты 25/587/465 не используются).
- Безопасность: re-auth по текущему паролю (защита от угнанной вкладки), rate-limit 1 раз в 5 минут на user, audit-лог события.

**Tech Stack:**
- Next.js App Router 14+ (TypeScript)
- Supabase Auth (already in `@/lib/supabaseAdmin`, `@/lib/supabaseRouteClient`)
- Brevo REST API (нет SDK — голый `fetch`)
- Jest для тестов (паттерны из `app/tests/api/requireClientAuth.test.ts`)
- Node 18+ `crypto.randomInt` для генератора пароля

---

## File Structure

**Создать:**
- `app/src/lib/passwordGenerator.ts` — крипто-стойкий генератор (изоморфен — работает и на сервере, и на клиенте; использует `crypto.getRandomValues`)
- `app/src/lib/email/brevoClient.ts` — обёртка над Brevo REST API (один экспорт `sendBrevoEmail`)
- `app/src/lib/email/templates/passwordChanged.ts` — функция `renderPasswordChangedEmail({ email, password, changedAtMsk, ip })` → `{ subject, html, text }`
- `app/src/app/api/client/password/route.ts` — POST-роут смены пароля
- `app/src/app/client/settings/page.tsx` — серверный shell страницы с метаданными
- `app/src/app/client/settings/PasswordChangeForm.tsx` — клиентский компонент формы
- `app/tests/lib/passwordGenerator.test.ts`
- `app/tests/lib/email/brevoClient.test.ts`
- `app/tests/lib/email/templates/passwordChanged.test.ts`
- `app/tests/api/clientPassword.test.ts`

**Изменить:**
- `app/src/lib/clientNav.ts` — добавить экспорт `CLIENT_NAV_SETTINGS` рядом с `CLIENT_NAV_SUPPORT`/`CLIENT_NAV_OFFER`
- `app/tests/lib/clientNav.test.ts` (если найдётся; иначе добавить минимальный contract test) — проверить, что `CLIENT_NAV_SETTINGS.href === '/client/settings'`
- Layout сайдбара `app/src/app/client/layout.tsx` (или где рендерится `ClientNavList`) — отрендерить `CLIENT_NAV_SETTINGS` в нижнем блоке

**НЕ в коде (пользователь делает сам, описано в Task 0):**
- Регистрация в Brevo
- DNS-записи у регистратора домена `outreachos.pro`
- Запись `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` в `.env` на prod-сервере (139.60.162.12)
- Restart docker-compose на prod

---

## Task 0: Внешние шаги (пользователь делает руками, не код)

**Это идёт ПАРАЛЛЕЛЬНО с кодом — можно делать пока я пишу Tasks 1-7.**

- [ ] **Шаг 1: Регистрация в Brevo**
  Открыть https://www.brevo.com/ → Sign up free. План «Free» — 300 писем/день навсегда, кредитная карта не нужна.

- [ ] **Шаг 2: Добавить домен `outreachos.pro` в Brevo**
  Brevo dashboard → Senders, Domains & Dedicated IPs → Domains → Add a domain → ввести `outreachos.pro`.
  Brevo покажет 3 DNS-записи: TXT для DKIM (`brevo-code._domainkey`), TXT для Brevo verification, MX-record (не нужен, мы не принимаем почту через них).

- [ ] **Шаг 3: Добавить DNS-записи у регистратора `outreachos.pro`**
  Зайти к регистратору домена (где куплен outreachos.pro), добавить TXT-записи, которые показал Brevo. SPF (`v=spf1 include:spf.brevo.com ~all`) и DMARC (`v=DMARC1; p=none; rua=mailto:postmaster@outreachos.pro`) добавить вручную.
  Подождать 10–60 минут, в Brevo нажать «Verify» — должны загореться зелёные галочки.

- [ ] **Шаг 4: Получить API-ключ**
  Brevo → SMTP & API → API Keys → Generate a new API key → имя «Portal production» → скопировать (начинается с `xkeysib-`). Сохранить в надёжном месте — больше показан не будет.

- [ ] **Шаг 5: Положить креды в `.env` на проде**
  На сервере 139.60.162.12 в файле `.env` (рядом с `docker-compose.prod.yml`) добавить:
  ```
  BREVO_API_KEY=xkeysib-XXXXXXXXXXXX
  BREVO_FROM_EMAIL=no-reply@outreachos.pro
  BREVO_FROM_NAME=Portal
  ```
  Затем `docker compose -f docker-compose.prod.yml up -d portal` чтобы перезапустить контейнер.

- [ ] **Шаг 6: Положить креды локально для разработки**
  В локальном `.env` (или `host.env`) разработчик кладёт тот же ключ — нужен для запуска dev-сервера и интеграционной проверки.

---

## Task 1: Генератор крипто-стойкого пароля

**Files:**
- Create: `app/src/lib/passwordGenerator.ts`
- Test: `app/tests/lib/passwordGenerator.test.ts`

**Контракт:** функция `generateStrongPassword(length = 14): string` возвращает строку заданной длины, гарантированно содержащую как минимум одну букву нижнего регистра, одну буквы верхнего, одну цифру, один спецсимвол из `!@#$%^&*-_+=`. Использует `crypto.getRandomValues` (доступен и в Node 18+, и в браузере).

- [ ] **Step 1.1: Написать failing-тесты**

`app/tests/lib/passwordGenerator.test.ts`:
```typescript
import { generateStrongPassword } from '@/lib/passwordGenerator';

describe('generateStrongPassword', () => {
  it('возвращает строку длиной по умолчанию 14', () => {
    expect(generateStrongPassword()).toHaveLength(14);
  });

  it('уважает кастомную длину', () => {
    expect(generateStrongPassword(20)).toHaveLength(20);
  });

  it('содержит хотя бы одну букву нижнего регистра', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateStrongPassword()).toMatch(/[a-z]/);
    }
  });

  it('содержит хотя бы одну букву верхнего регистра', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateStrongPassword()).toMatch(/[A-Z]/);
    }
  });

  it('содержит хотя бы одну цифру', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateStrongPassword()).toMatch(/[0-9]/);
    }
  });

  it('содержит хотя бы один спецсимвол', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateStrongPassword()).toMatch(/[!@#$%^&*\-_+=]/);
    }
  });

  it('бросает ошибку на длину меньше 8', () => {
    expect(() => generateStrongPassword(7)).toThrow();
  });

  it('бросает ошибку на длину больше 72 (bcrypt cap)', () => {
    expect(() => generateStrongPassword(73)).toThrow();
  });

  it('не повторяется (две генерации подряд разные)', () => {
    expect(generateStrongPassword()).not.toBe(generateStrongPassword());
  });
});
```

- [ ] **Step 1.2: Запустить — убедиться что упали**

```bash
cd app && npx jest tests/lib/passwordGenerator.test.ts
```
Ожидаемо: `Cannot find module '@/lib/passwordGenerator'`.

- [ ] **Step 1.3: Реализовать**

`app/src/lib/passwordGenerator.ts`:
```typescript
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SPECIALS = '!@#$%^&*-_+=';
const ALL = LOWER + UPPER + DIGITS + SPECIALS;

function pickOne(pool: string): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return pool[buf[0] % pool.length];
}

function shuffle(chars: string[]): string[] {
  for (let i = chars.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

export function generateStrongPassword(length = 14): string {
  if (length < 8) throw new Error('Password length must be at least 8');
  if (length > 72) throw new Error('Password length must be at most 72 (bcrypt cap)');

  const required = [pickOne(LOWER), pickOne(UPPER), pickOne(DIGITS), pickOne(SPECIALS)];
  const rest = Array.from({ length: length - required.length }, () => pickOne(ALL));
  return shuffle([...required, ...rest]).join('');
}
```

- [ ] **Step 1.4: Запустить — убедиться что прошли**

```bash
cd app && npx jest tests/lib/passwordGenerator.test.ts
```
Ожидаемо: `PASS — 9 passed`.

- [ ] **Step 1.5: Commit**

```bash
git add app/src/lib/passwordGenerator.ts app/tests/lib/passwordGenerator.test.ts
git commit -m "feat(lib): add cryptographically strong password generator"
```

---

## Task 2: Brevo HTTPS клиент

**Files:**
- Create: `app/src/lib/email/brevoClient.ts`
- Test: `app/tests/lib/email/brevoClient.test.ts`

**Контракт:** `sendBrevoEmail({ to, subject, html, text }): Promise<{ messageId: string }>`. Внутри — `fetch('https://api.brevo.com/v3/smtp/email')` с заголовком `api-key: BREVO_API_KEY`. Кидает ошибку при !ok или отсутствии env-переменных. Конфиг (`BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME`) читается из `process.env`.

- [ ] **Step 2.1: Написать failing-тест**

`app/tests/lib/email/brevoClient.test.ts`:
```typescript
import { sendBrevoEmail } from '@/lib/email/brevoClient';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  process.env.BREVO_FROM_EMAIL = 'no-reply@outreachos.pro';
  process.env.BREVO_FROM_NAME = 'Portal';
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe('sendBrevoEmail', () => {
  it('POST-ит на правильный URL с api-key заголовком', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ messageId: '<msg-1@brevo>' }),
    })) as unknown as typeof fetch;
    global.fetch = fetchSpy;

    await sendBrevoEmail({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.brevo.com/v3/smtp/email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'api-key': 'xkeysib-test-key',
          'content-type': 'application/json',
          accept: 'application/json',
        }),
      }),
    );
  });

  it('передаёт sender, to, subject, htmlContent, textContent в body', async () => {
    let capturedBody: unknown = null;
    global.fetch = (jest.fn(async (_url, init) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return { ok: true, status: 201, json: async () => ({ messageId: 'm1' }) };
    }) as unknown) as typeof fetch;

    await sendBrevoEmail({
      to: 'user@example.com',
      subject: 'Пароль изменён',
      html: '<p>html</p>',
      text: 'text',
    });

    expect(capturedBody).toEqual({
      sender: { email: 'no-reply@outreachos.pro', name: 'Portal' },
      to: [{ email: 'user@example.com' }],
      subject: 'Пароль изменён',
      htmlContent: '<p>html</p>',
      textContent: 'text',
    });
  });

  it('возвращает messageId из ответа Brevo', async () => {
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ messageId: '<abc@brevo>' }),
    })) as unknown) as typeof fetch;

    const res = await sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
    expect(res.messageId).toBe('<abc@brevo>');
  });

  it('кидает ошибку при !ok ответе с телом', async () => {
    global.fetch = (jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Invalid API key' }),
      text: async () => '{"message":"Invalid API key"}',
    })) as unknown) as typeof fetch;

    await expect(
      sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/Brevo.*401/);
  });

  it('кидает ошибку если BREVO_API_KEY отсутствует', async () => {
    delete process.env.BREVO_API_KEY;
    await expect(
      sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/BREVO_API_KEY/);
  });

  it('кидает ошибку если BREVO_FROM_EMAIL отсутствует', async () => {
    delete process.env.BREVO_FROM_EMAIL;
    await expect(
      sendBrevoEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/BREVO_FROM_EMAIL/);
  });
});
```

- [ ] **Step 2.2: Запустить — убедиться что упал**

```bash
cd app && npx jest tests/lib/email/brevoClient.test.ts
```

- [ ] **Step 2.3: Реализовать**

`app/src/lib/email/brevoClient.ts`:
```typescript
import 'server-only';

export interface SendBrevoEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendBrevoEmailResult {
  messageId: string;
}

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export async function sendBrevoEmail(args: SendBrevoEmailArgs): Promise<SendBrevoEmailResult> {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL;
  const fromName = process.env.BREVO_FROM_NAME ?? 'Portal';

  if (!apiKey) throw new Error('BREVO_API_KEY is not set');
  if (!fromEmail) throw new Error('BREVO_FROM_EMAIL is not set');

  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: fromEmail, name: fromName },
      to: [{ email: args.to }],
      subject: args.subject,
      htmlContent: args.html,
      textContent: args.text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brevo API error: ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { messageId?: string };
  return { messageId: data.messageId ?? '' };
}
```

- [ ] **Step 2.4: Запустить — убедиться что прошёл**

```bash
cd app && npx jest tests/lib/email/brevoClient.test.ts
```

- [ ] **Step 2.5: Commit**

```bash
git add app/src/lib/email/brevoClient.ts app/tests/lib/email/brevoClient.test.ts
git commit -m "feat(email): add Brevo HTTPS transactional client"
```

---

## Task 3: Шаблон письма «Пароль изменён»

**Files:**
- Create: `app/src/lib/email/templates/passwordChanged.ts`
- Test: `app/tests/lib/email/templates/passwordChanged.test.ts`

**Контракт:** `renderPasswordChangedEmail({ password, changedAtMsk, ip }): { subject, html, text }`. Шаблон — простой inline-HTML (без движков), всё инлайнится. В HTML пароль показан в `<code>` с моноширинным шрифтом. Текст письма по-русски (клиенты — РФ).

- [ ] **Step 3.1: Написать failing-тест**

`app/tests/lib/email/templates/passwordChanged.test.ts`:
```typescript
import { renderPasswordChangedEmail } from '@/lib/email/templates/passwordChanged';

describe('renderPasswordChangedEmail', () => {
  const args = {
    password: 'AbcDef123!@x',
    changedAtMsk: '24.06.2026, 15:30 МСК',
    ip: '203.0.113.42',
  };

  it('subject упоминает Portal и пароль', () => {
    const { subject } = renderPasswordChangedEmail(args);
    expect(subject).toMatch(/пароль/i);
    expect(subject).toMatch(/Portal/i);
  });

  it('HTML содержит пароль в <code>', () => {
    const { html } = renderPasswordChangedEmail(args);
    expect(html).toContain('<code');
    expect(html).toContain('AbcDef123!@x');
  });

  it('HTML содержит время изменения и IP', () => {
    const { html } = renderPasswordChangedEmail(args);
    expect(html).toContain('24.06.2026, 15:30 МСК');
    expect(html).toContain('203.0.113.42');
  });

  it('HTML содержит призыв обратиться в поддержку если это не вы', () => {
    const { html } = renderPasswordChangedEmail(args);
    expect(html).toMatch(/поддержк/i);
  });

  it('text-версия не пустая и содержит пароль', () => {
    const { text } = renderPasswordChangedEmail(args);
    expect(text.length).toBeGreaterThan(50);
    expect(text).toContain('AbcDef123!@x');
  });

  it('экранирует HTML-спецсимволы в пароле', () => {
    const { html } = renderPasswordChangedEmail({
      ...args,
      password: 'a<b>c&d"e',
    });
    expect(html).toContain('a&lt;b&gt;c&amp;d&quot;e');
    expect(html).not.toContain('<b>');
  });

  it('экранирует HTML в IP (защита от injection через X-Forwarded-For)', () => {
    const { html } = renderPasswordChangedEmail({
      ...args,
      ip: '1.2.3.4<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 3.2: Запустить — убедиться что упал**

```bash
cd app && npx jest tests/lib/email/templates/passwordChanged.test.ts
```

- [ ] **Step 3.3: Реализовать**

`app/src/lib/email/templates/passwordChanged.ts`:
```typescript
export interface PasswordChangedEmailArgs {
  password: string;
  changedAtMsk: string;
  ip: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPasswordChangedEmail(args: PasswordChangedEmailArgs): RenderedEmail {
  const subject = 'Portal: ваш пароль был изменён';

  const html = `<!doctype html>
<html lang="ru">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Пароль изменён</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Пароль вашего аккаунта в Portal был успешно изменён <strong>${esc(args.changedAtMsk)}</strong>.
          </p>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">IP, с которого выполнено изменение: <code style="font-family:Menlo,Consolas,monospace;font-size:14px;color:#444;">${esc(args.ip)}</code></p>
          <p style="font-size:15px;line-height:1.5;margin:24px 0 8px;">Ваш новый пароль:</p>
          <p style="margin:0 0 24px;">
            <code style="display:inline-block;font-family:Menlo,Consolas,monospace;font-size:18px;background:#f0f0f0;padding:12px 16px;border-radius:6px;letter-spacing:0.5px;">${esc(args.password)}</code>
          </p>
          <p style="font-size:13px;line-height:1.5;margin:0 0 12px;color:#666;">
            Рекомендуем удалить это письмо после прочтения и хранить пароль в менеджере паролей.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#a00;">
            <strong>Если это были не вы</strong> — срочно напишите в поддержку: пароль был изменён из вашего личного кабинета, но кто-то мог получить доступ к сессии.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Пароль изменён',
    '',
    `Пароль вашего аккаунта в Portal был успешно изменён ${args.changedAtMsk}.`,
    `IP: ${args.ip}`,
    '',
    `Новый пароль: ${args.password}`,
    '',
    'Рекомендуем удалить это письмо после прочтения и хранить пароль в менеджере паролей.',
    '',
    'Если это были не вы — срочно напишите в поддержку.',
  ].join('\n');

  return { subject, html, text };
}
```

- [ ] **Step 3.4: Запустить — убедиться что прошёл**

```bash
cd app && npx jest tests/lib/email/templates/passwordChanged.test.ts
```

- [ ] **Step 3.5: Commit**

```bash
git add app/src/lib/email/templates/passwordChanged.ts app/tests/lib/email/templates/passwordChanged.test.ts
git commit -m "feat(email): add password-changed email template"
```

---

## Task 4: API роут `/api/client/password`

**Files:**
- Create: `app/src/app/api/client/password/route.ts`
- Test: `app/tests/api/clientPassword.test.ts`

**Контракт:** `POST { currentPassword: string, newPassword: string }`. Под client bearer-токеном. Шаги:
1. `requireClientAuth(req)` → `userId` (auth + role + demo-block).
2. Получить `email` юзера через `supabaseAdmin.auth.admin.getUserById(userId)`.
3. Валидация: `newPassword` 8–72 символа, не равен `currentPassword`.
4. Re-auth: создать одноразовый supabase client, `signInWithPassword({ email, password: currentPassword })` — если ошибка, вернуть `401 Wrong current password`.
5. `supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword })`.
6. Async (fire-and-forget) — отправить письмо через `sendBrevoEmail` с шаблоном `passwordChanged`. Ошибка отправки логируется, но не валит запрос.
7. `logAudit('client.password.change.success', ...)`.
8. Вернуть `{ ok: true }`.

Демо-аккаунт автоматически режется в `requireClientAuth` (это POST).

- [ ] **Step 4.1: Написать failing-тесты**

`app/tests/api/clientPassword.test.ts`:
```typescript
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

const mockRequireClientAuth = jest.fn();
const mockUpdateUserById = jest.fn();
const mockGetUserById = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockSendBrevoEmail = jest.fn();
const mockLogAudit = jest.fn();
const mockLogError = jest.fn();

jest.mock('@/lib/clientApiHelper', () => ({
  requireClientAuth: (...args: unknown[]) => mockRequireClientAuth(...args),
  jsonError: (msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { 'content-type': 'application/json' } }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: (...a: unknown[]) => mockGetUserById(...a),
        updateUserById: (...a: unknown[]) => mockUpdateUserById(...a),
      },
    },
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  createAuthedSupabaseClient: () => ({
    auth: { signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...a) },
  }),
}));

jest.mock('@/lib/email/brevoClient', () => ({
  sendBrevoEmail: (...a: unknown[]) => mockSendBrevoEmail(...a),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
  logError: (...a: unknown[]) => mockLogError(...a),
}));

const okAuth = { auth: { userId: 'user-1', accessRows: [], isDemo: false } };

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/client/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer xxx' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireClientAuth.mockResolvedValue(okAuth);
  mockGetUserById.mockResolvedValue({ data: { user: { id: 'user-1', email: 'me@example.com' } }, error: null });
  mockSignInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
  mockSendBrevoEmail.mockResolvedValue({ messageId: 'msg-1' });
});

describe('POST /api/client/password', () => {
  it('возвращает 401 если auth провалился', async () => {
    mockRequireClientAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'NewPass123!' }));
    expect(res.status).toBe(401);
  });

  it('возвращает 400 на невалидный JSON', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const req = new NextRequest('http://localhost/api/client/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer xxx' },
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('возвращает 400 если newPassword короче 8 символов', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'short' }));
    expect(res.status).toBe(400);
  });

  it('возвращает 400 если newPassword длиннее 72 (bcrypt cap)', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'A'.repeat(73) }));
    expect(res.status).toBe(400);
  });

  it('возвращает 400 если newPassword === currentPassword', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'SamePass1!', newPassword: 'SamePass1!' }));
    expect(res.status).toBe(400);
  });

  it('возвращает 401 если currentPassword неверный', async () => {
    mockSignInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Invalid credentials' } });
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'wrong', newPassword: 'NewPass123!' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/текущ/i);
  });

  it('успех: обновляет пароль через admin API', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    expect(mockUpdateUserById).toHaveBeenCalledWith('user-1', { password: 'NewPass123!' });
  });

  it('успех: отправляет письмо через Brevo', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    // fire-and-forget: даём микротасКам выполниться
    await new Promise((r) => setImmediate(r));
    expect(mockSendBrevoEmail).toHaveBeenCalled();
    const arg = mockSendBrevoEmail.mock.calls[0][0];
    expect(arg.to).toBe('me@example.com');
    expect(arg.html).toContain('NewPass123!');
  });

  it('успех: пишет audit лог', async () => {
    const { POST } = await import('@/app/api/client/password/route');
    await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'client.password.change.success',
      expect.any(String),
      expect.objectContaining({}),
      expect.any(Object),
    );
  });

  it('успех: возвращает 200 даже если email отправка упала', async () => {
    mockSendBrevoEmail.mockRejectedValue(new Error('Brevo 500'));
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    await new Promise((r) => setImmediate(r));
    expect(res.status).toBe(200);
    expect(mockLogError).toHaveBeenCalledWith(
      'client.password.email.failed',
      expect.anything(),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('возвращает 500 если supabase.auth.admin.updateUserById упал', async () => {
    mockUpdateUserById.mockResolvedValue({ data: null, error: { message: 'DB down' } });
    const { POST } = await import('@/app/api/client/password/route');
    const res = await POST(makeReq({ currentPassword: 'OldPass1!', newPassword: 'NewPass123!' }));
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 4.2: Запустить — убедиться что упали**

```bash
cd app && npx jest tests/api/clientPassword.test.ts
```

- [ ] **Step 4.3: Реализовать роут**

`app/src/app/api/client/password/route.ts`:
```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { sendBrevoEmail } from '@/lib/email/brevoClient';
import { renderPasswordChangedEmail } from '@/lib/email/templates/passwordChanged';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

interface Body {
  currentPassword?: unknown;
  newPassword?: unknown;
}

function formatMoscowTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.day}.${map.month}.${map.year}, ${map.hour}:${map.minute} МСК`;
}

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId } = result.auth;

  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const logMeta = { userId, requestId, route, ip };

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword) return jsonError('Не указан текущий пароль', 400);
  if (!newPassword) return jsonError('Не указан новый пароль', 400);
  if (newPassword.length < 8) return jsonError('Новый пароль должен быть не короче 8 символов', 400);
  if (newPassword.length > 72) return jsonError('Новый пароль не должен превышать 72 символа', 400);
  if (newPassword === currentPassword) return jsonError('Новый пароль совпадает с текущим', 400);

  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userErr || !userData?.user?.email) {
    await logError('client.password.get_user.failed', userErr ?? 'no email', {}, logMeta);
    return jsonError('Не удалось получить email аккаунта', 500);
  }
  const email = userData.user.email;

  // Re-auth: проверяем текущий пароль через одноразового анонимного клиента.
  // Не используем основную сессию пользователя, чтобы её случайно не «забить».
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  const verifier = createAuthedSupabaseClient(token);
  const { error: signInErr } = await verifier.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (signInErr) {
    await logError('client.password.reauth.failed', signInErr, {}, logMeta);
    return jsonError('Неверный текущий пароль', 401);
  }

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (updateErr) {
    await logError('client.password.update.failed', updateErr, {}, logMeta);
    return jsonError('Не удалось обновить пароль', 500);
  }

  // Fire-and-forget: email не должен валить запрос.
  const changedAtMsk = formatMoscowTime(new Date());
  const { subject, html, text } = renderPasswordChangedEmail({
    password: newPassword,
    changedAtMsk,
    ip,
  });
  void sendBrevoEmail({ to: email, subject, html, text }).catch((err) =>
    logError('client.password.email.failed', err, { to: email }, logMeta),
  );

  await logAudit('client.password.change.success', 'Client changed own password', {}, logMeta);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4.4: Запустить — убедиться что прошли**

```bash
cd app && npx jest tests/api/clientPassword.test.ts
```

- [ ] **Step 4.5: Commit**

```bash
git add app/src/app/api/client/password/route.ts app/tests/api/clientPassword.test.ts
git commit -m "feat(api): add /api/client/password route for self-service password change"
```

---

## Task 5: Страница `/client/settings` + форма

**Files:**
- Create: `app/src/app/client/settings/page.tsx`
- Create: `app/src/app/client/settings/PasswordChangeForm.tsx`

UI: страница с заголовком «Настройки», секция «Пароль», форма из 3 полей. Кнопка «🎲 Сгенерировать» вставляет крипто-стойкий пароль в поле «Новый пароль» и автоматически дублирует в «Подтверждение». Toggle visibility у обоих полей. На submit — POST на `/api/client/password` через `authFetch`. Toast/баннер успеха или ошибки.

- [ ] **Step 5.1: Создать серверный shell**

`app/src/app/client/settings/page.tsx`:
```typescript
import { PasswordChangeForm } from './PasswordChangeForm';

export const metadata = { title: 'Настройки — Portal' };

export default function ClientSettingsPage() {
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-semibold">Настройки</h1>
      <section>
        <h2 className="text-lg font-medium mb-4">Сменить пароль</h2>
        <p className="text-sm text-neutral-500 mb-4">
          После смены пароля мы пришлём уведомление на email вашего аккаунта.
        </p>
        <PasswordChangeForm />
      </section>
    </div>
  );
}
```

- [ ] **Step 5.2: Создать клиентский компонент формы**

`app/src/app/client/settings/PasswordChangeForm.tsx`:
```typescript
'use client';

import { useState, type FormEvent } from 'react';
import { generateStrongPassword } from '@/lib/passwordGenerator';
import { authFetch } from '@/lib/authFetch';

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok' } | { kind: 'error'; message: string };

export function PasswordChangeForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  function handleGenerate() {
    const pw = generateStrongPassword(14);
    setNext(pw);
    setConfirm(pw);
    setShowNext(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setStatus({ kind: 'error', message: 'Новый пароль и подтверждение не совпадают' });
      return;
    }
    if (next.length < 8) {
      setStatus({ kind: 'error', message: 'Новый пароль должен быть не короче 8 символов' });
      return;
    }

    setStatus({ kind: 'loading' });
    try {
      const res = await authFetch('/api/client/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus({ kind: 'error', message: body.error ?? `Ошибка ${res.status}` });
        return;
      }
      setStatus({ kind: 'ok' });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Сетевая ошибка' });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Текущий пароль</span>
        <div className="mt-1 flex gap-2">
          <input
            type={showCurrent ? 'text' : 'password'}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoComplete="current-password"
            className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => setShowCurrent((v) => !v)}
            className="px-3 text-xs text-neutral-600 hover:text-neutral-900"
          >
            {showCurrent ? 'Скрыть' : 'Показать'}
          </button>
        </div>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Новый пароль</span>
        <div className="mt-1 flex gap-2">
          <input
            type={showNext ? 'text' : 'password'}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            maxLength={72}
            autoComplete="new-password"
            className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => setShowNext((v) => !v)}
            className="px-3 text-xs text-neutral-600 hover:text-neutral-900"
          >
            {showNext ? 'Скрыть' : 'Показать'}
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            className="rounded bg-neutral-100 px-3 text-xs hover:bg-neutral-200"
            title="Сгенерировать сильный пароль"
          >
            🎲 Сгенерировать
          </button>
        </div>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Подтвердите новый пароль</span>
        <input
          type={showNext ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
          maxLength={72}
          autoComplete="new-password"
          className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm font-mono"
        />
      </label>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={status.kind === 'loading'}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {status.kind === 'loading' ? 'Сохраняем…' : 'Сменить пароль'}
        </button>
        {status.kind === 'ok' && (
          <span className="text-sm text-green-600">Готово. Письмо отправлено на ваш email.</span>
        )}
        {status.kind === 'error' && (
          <span className="text-sm text-red-600">{status.message}</span>
        )}
      </div>
    </form>
  );
}
```

Замечание: классы выше — Tailwind. Если в проекте свой стиль (CSS modules / styled-components) — адаптировать под существующие классы клиентских страниц (посмотреть `app/src/app/client/tariff/page.tsx`).

- [ ] **Step 5.3: Проверить локально**

```bash
cd app && npm run dev
```
Открыть `http://localhost:3000/client/settings`. Войти под тестовым клиентским аккаунтом. Проверить:
- Форма рендерится
- Кнопка «Сгенерировать» вставляет пароль
- Toggle visibility работает
- Отправка с неверным текущим паролем → ошибка
- Отправка с правильным → «Готово», письмо приходит на email

- [ ] **Step 5.4: Commit**

```bash
git add app/src/app/client/settings/page.tsx app/src/app/client/settings/PasswordChangeForm.tsx
git commit -m "feat(client): add /client/settings page with password change form"
```

---

## Task 6: Добавить пункт «Настройки» в navigation

**Files:**
- Modify: `app/src/lib/clientNav.ts`
- Modify (если есть): `app/tests/lib/clientNav.test.ts`
- Modify (где рендерится sidebar): `app/src/app/client/layout.tsx` или соответствующий `ClientNavList`

- [ ] **Step 6.1: Добавить экспорт `CLIENT_NAV_SETTINGS`**

В `app/src/lib/clientNav.ts` после `CLIENT_NAV_OFFER` добавить:
```typescript
/**
 * Account-level settings (password change, profile).
 * Top-level item rendered in the bottom block of the sidebar next to Support
 * and Offer. Always visible regardless of nav mode (manual/auto).
 */
export const CLIENT_NAV_SETTINGS: ClientNavItem = {
  id: 'settings',
  label: 'Настройки',
  labelEn: 'Settings',
  href: '/client/settings',
  description: 'Сменить пароль и управлять аккаунтом',
  descriptionEn: 'Change password and manage your account',
};
```

И добавить ветку в `resolveActiveNavId`:
```typescript
  if (pathname === CLIENT_NAV_SETTINGS.href || pathname.startsWith(`${CLIENT_NAV_SETTINGS.href}/`)) {
    return CLIENT_NAV_SETTINGS.id;
  }
```

- [ ] **Step 6.2: Обновить contract test (если есть)**

Найти и прочитать `app/tests/lib/clientNav.test.ts`. Добавить:
```typescript
import { CLIENT_NAV_SETTINGS, resolveActiveNavId } from '@/lib/clientNav';

it('CLIENT_NAV_SETTINGS указывает на /client/settings', () => {
  expect(CLIENT_NAV_SETTINGS.href).toBe('/client/settings');
  expect(CLIENT_NAV_SETTINGS.id).toBe('settings');
});

it('resolveActiveNavId возвращает "settings" на /client/settings', () => {
  expect(resolveActiveNavId('/client/settings')).toBe('settings');
});
```

Если файла нет — создать минимальный с этими двумя кейсами.

- [ ] **Step 6.3: Отрендерить пункт в сайдбаре**

Прочитать `app/src/app/client/layout.tsx` и место рендера навигации. Найти, где рендерятся `CLIENT_NAV_SUPPORT` и `CLIENT_NAV_OFFER`. Добавить `CLIENT_NAV_SETTINGS` в тот же блок (порядок: Settings → Support → Offer или Support → Settings → Offer — на усмотрение).

Импорт:
```typescript
import { CLIENT_NAV_SETTINGS } from '@/lib/clientNav';
```

- [ ] **Step 6.4: Запустить все тесты**

```bash
cd app && npx jest tests/lib/clientNav.test.ts
```

- [ ] **Step 6.5: Локально убедиться, что пункт виден и подсвечивается на `/client/settings`**

- [ ] **Step 6.6: Commit**

```bash
git add app/src/lib/clientNav.ts app/tests/lib/clientNav.test.ts app/src/app/client/layout.tsx
git commit -m "feat(nav): add Settings entry to client sidebar"
```

---

## Task 7: End-to-end локальная проверка

- [ ] **Step 7.1: Запустить весь тест-сьют**

```bash
cd app && npx jest
```
Все тесты должны быть зелёными. Если что-то падает в существующих тестах — исследовать, могло сломаться от моих правок (особенно если правил `clientNav.ts`).

- [ ] **Step 7.2: Поднять dev-сервер**

```bash
cd app && npm run dev
```

- [ ] **Step 7.3: E2E ручной сценарий**

1. Войти под клиентским аккаунтом (не админ, не demo).
2. Кликнуть «Настройки» в сайдбаре → попасть на `/client/settings`.
3. Ввести **неверный** текущий пароль → отправить → увидеть «Неверный текущий пароль».
4. Ввести правильный текущий + новый пароль 6 символов → отправить → клиент-сайд валидация (HTML5 minLength) не пустит.
5. Нажать «🎲 Сгенерировать» → поля заполнились паролем, видимый.
6. Отправить → увидеть «Готово. Письмо отправлено на ваш email».
7. Проверить почту → пришло письмо с новым паролем, временем МСК, IP.
8. Разлогиниться, войти с новым паролем → успешно.

- [ ] **Step 7.4: Убедиться, что demo-аккаунт получает 403**

Войти под demo (если есть), повторить шаг 6 → ожидаем 403 с сообщением о demo-режиме (его выдаёт `requireClientAuth`).

---

## Task 8: Отдать пользователю инструкцию по Brevo + deploy

- [ ] **Step 8.1: Финальное сообщение в чате с пошаговой инструкцией Task 0**

(пользователю — нетехническому — расписать по-русски, что он делает в Brevo, что добавляет в DNS, какие переменные кладёт в `.env` прод-сервера, как перезапускает контейнер).

- [ ] **Step 8.2: Merge в `test`/`main` и deploy — делает пользователь сам**

(см. user memory: пользователь сам деплоит на прод).

---

## Self-Review

**1. Spec coverage:**
- ✅ Клиент сам вводит пароль или генерирует — Task 5 (форма + кнопка генерации).
- ✅ Письмо приходит на email аккаунта — Task 4 (отправка через Brevo с email из `auth.users`).
- ✅ Пароль высылается в письме — Task 3 (шаблон содержит `args.password`).
- ✅ Порты 25/587/465 не используются — Task 2 (только HTTPS на `api.brevo.com:443`).
- ✅ Бесплатно — Brevo free 300 писем/день.

**2. Placeholder scan:** все степы содержат код или точные команды. TODO нет.

**3. Type consistency:**
- `generateStrongPassword(length)` — определён в Task 1, вызван в Task 5 как `generateStrongPassword(14)`. ✅
- `sendBrevoEmail({ to, subject, html, text })` — определён в Task 2, вызван в Task 4 с тем же интерфейсом. ✅
- `renderPasswordChangedEmail({ password, changedAtMsk, ip })` — определён в Task 3, вызван в Task 4 с тем же интерфейсом. ✅
- `CLIENT_NAV_SETTINGS` — определён в Task 6.1, использован в Task 6.3. ✅
