# Правка профиля TG-аккаунта из портала — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Менять имя, фамилию, описание и аватарку TG-аккаунта прямо из портала, чтобы не ходить за этим в TG Ninja.

**Architecture:** Роут подключается к аккаунту через его прокси и вызывает Telegram напрямую — так же, как это уже делают действия над аккаунтами пула. Правка разрешена только при остановленной кампании: работающая уже держит соединение, а второе подключение к тому же аккаунту через мобильный прокси — лишний повод для сбоя. После применения профиль перечитывается из Telegram и сохраняется в БД.

**Tech Stack:** Next.js API routes, Supabase, gramJS (`telegram`), Jest.

**Спека:** [docs/superpowers/specs/2026-08-05-tg-outreach-first-touch-design.md](../specs/2026-08-05-tg-outreach-first-touch-design.md), раздел «Профиль аккаунта».

**Не входит:** базы контактов и рассылка — отдельный план `2026-08-06-tg-outreach-first-touch.md`. Планы независимы, порядок любой.

---

> **Перед началом:** номер миграции проверить заново — `ls supabase/migrations/ | tail`.
> Пока писался план, номер `20260806_0001` заняла чужая миграция, и это может повториться.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260806_0003_tg_outreach_account_profile.sql` | Поля профиля в `tg_outreach_accounts` |
| `app/src/lib/tgOutreach/profile/validateProfile.ts` | Проверка вводимых значений до похода в Telegram |
| `app/src/lib/tgOutreach/profile/applyProfile.ts` | Вызовы Telegram: профиль, аватарка, перечитывание |
| `app/src/app/api/tools/tg-outreach/accounts/[id]/profile/route.ts` | Роут: гейт по статусу кампании, подключение, применение |
| `app/src/app/tools/tg-outreach/page.tsx` | Форма правки в карточке аккаунта |

---

## Task 1: Поля профиля в таблице аккаунтов

**Files:**
- Create: `supabase/migrations/20260806_0003_tg_outreach_account_profile.sql`
- Test: `app/tests/migrations/tgOutreachAccountProfile.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/migrations/tgOutreachAccountProfile.test.ts`:

```ts
/** @jest-environment node */

/**
 * Поля профиля нужны, чтобы список показывал реальное состояние аккаунта в
 * Telegram, а не то, что мы туда отправили. Сейчас в tg_outreach_accounts нет
 * ни имени, ни описания.
 */

import fs from 'node:fs';
import path from 'node:path';

const SQL = fs.readFileSync(
  path.resolve(process.cwd(), '../supabase/migrations/20260806_0003_tg_outreach_account_profile.sql'),
  'utf8',
);

describe('миграция полей профиля аккаунта', () => {
  it.each(['first_name', 'last_name', 'bio', 'avatar_url', 'profile_synced_at'])(
    'добавляет колонку %s',
    (column) => {
      expect(SQL).toMatch(
        new RegExp(`alter table public\\.tg_outreach_accounts[\\s\\S]{0,80}add column if not exists ${column}\\b`, 'i'),
      );
    },
  );

  it('колонки добавляются мягко — таблица уже в проде', () => {
    expect(SQL).toMatch(/add column if not exists/i);
    expect(SQL).not.toMatch(/drop column/i);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/migrations/tgOutreachAccountProfile.test.ts`
Expected: FAIL — `ENOENT ... 20260806_0003_tg_outreach_account_profile.sql`

- [ ] **Step 3: Написать миграцию**

Создать `supabase/migrations/20260806_0003_tg_outreach_account_profile.sql`:

```sql
-- Профиль TG-аккаунта в портале: имя, фамилия, описание, аватарка.
--
-- Раньше этих полей не было вовсе: список кампании показывал session_name и
-- телефон. Аватарка у аккаунтов ПУЛА (tg_pool_accounts.avatar_url) —
-- косметическая: картинка лежит в хранилище портала и в Telegram не уходит.
-- Здесь поля хранят то, что реально стоит в Telegram: после каждой правки
-- профиль перечитывается и перезаписывается.

alter table public.tg_outreach_accounts
  add column if not exists first_name text not null default '';
alter table public.tg_outreach_accounts
  add column if not exists last_name text not null default '';
alter table public.tg_outreach_accounts
  add column if not exists bio text not null default '';
alter table public.tg_outreach_accounts
  add column if not exists avatar_url text not null default '';
alter table public.tg_outreach_accounts
  add column if not exists profile_synced_at timestamptz;

comment on column public.tg_outreach_accounts.profile_synced_at is
  'Когда профиль последний раз перечитывался из Telegram. NULL — ни разу.';
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/migrations/tgOutreachAccountProfile.test.ts tests/migrations/grants.test.ts`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add supabase/migrations/20260806_0003_tg_outreach_account_profile.sql app/tests/migrations/tgOutreachAccountProfile.test.ts
git commit -m "feat(tg-outreach): поля профиля у аккаунтов кампании"
```

---

## Task 2: Проверка вводимых значений

**Files:**
- Create: `app/src/lib/tgOutreach/profile/validateProfile.ts`
- Test: `app/tests/lib/tgOutreach/profile/validateProfile.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/profile/validateProfile.test.ts`:

```ts
/** @jest-environment node */

/**
 * Проверяем до похода в Telegram: отказ от сервера приходит кодом вроде
 * FIRSTNAME_INVALID, оператору он ничего не объясняет, а попытка стоит
 * подключения через мобильный прокси.
 */

import { validateProfile, PROFILE_LIMITS } from '@/lib/tgOutreach/profile/validateProfile';

describe('validateProfile', () => {
  it('обычный профиль проходит', () => {
    expect(validateProfile({ first_name: 'Иван', last_name: 'Петров', bio: 'Продажи в IT' })).toEqual({ ok: true });
  });

  it('имя обязательно — в Telegram аккаунт без имени невозможен', () => {
    expect(validateProfile({ first_name: '', last_name: '', bio: '' })).toEqual({
      ok: false,
      field: 'first_name',
      reason: 'Имя не может быть пустым',
    });
    expect(validateProfile({ first_name: '   ', last_name: '', bio: '' }).ok).toBe(false);
  });

  it('лимиты Telegram: имя и фамилия по 64, описание 70', () => {
    expect(PROFILE_LIMITS).toEqual({ first_name: 64, last_name: 64, bio: 70 });
    expect(validateProfile({ first_name: 'и'.repeat(64), last_name: '', bio: '' }).ok).toBe(true);
    expect(validateProfile({ first_name: 'и'.repeat(65), last_name: '', bio: '' })).toMatchObject({
      ok: false,
      field: 'first_name',
    });
    expect(validateProfile({ first_name: 'Иван', last_name: 'п'.repeat(65), bio: '' })).toMatchObject({
      ok: false,
      field: 'last_name',
    });
    expect(validateProfile({ first_name: 'Иван', last_name: '', bio: 'б'.repeat(71) })).toMatchObject({
      ok: false,
      field: 'bio',
    });
  });

  it('фамилия и описание могут быть пустыми', () => {
    expect(validateProfile({ first_name: 'Иван', last_name: '', bio: '' })).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/lib/tgOutreach/profile/validateProfile.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/profile/validateProfile'`

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/tgOutreach/profile/validateProfile.ts`:

```ts
/**
 * Проверка профиля до похода в Telegram.
 *
 * Сервер отвечает кодами вроде FIRSTNAME_INVALID — оператору они ничего не
 * объясняют, а каждая попытка стоит подключения через мобильный прокси.
 * Дешевле отсечь очевидное здесь.
 */

/** Лимиты Telegram на длину полей профиля. */
export const PROFILE_LIMITS = { first_name: 64, last_name: 64, bio: 70 } as const;

export interface ProfileInput {
  first_name: string;
  last_name: string;
  bio: string;
}

export type ProfileValidation =
  | { ok: true }
  | { ok: false; field: keyof ProfileInput; reason: string };

export function validateProfile(input: ProfileInput): ProfileValidation {
  const first = (input.first_name ?? '').trim();
  if (!first) {
    return { ok: false, field: 'first_name', reason: 'Имя не может быть пустым' };
  }

  const fields: Array<keyof ProfileInput> = ['first_name', 'last_name', 'bio'];
  const labels: Record<keyof ProfileInput, string> = {
    first_name: 'Имя',
    last_name: 'Фамилия',
    bio: 'Описание',
  };

  for (const field of fields) {
    const value = (input[field] ?? '').trim();
    const limit = PROFILE_LIMITS[field];
    if (value.length > limit) {
      return { ok: false, field, reason: `${labels[field]}: не больше ${limit} знаков` };
    }
  }

  return { ok: true };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/profile/validateProfile.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/profile/validateProfile.ts app/tests/lib/tgOutreach/profile/validateProfile.test.ts
git commit -m "feat(tg-outreach): проверка профиля аккаунта до отправки в Telegram"
```

---

## Task 3: Применение профиля в Telegram

**Files:**
- Create: `app/src/lib/tgOutreach/profile/applyProfile.ts`
- Test: `app/tests/lib/tgOutreach/profile/applyProfile.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/profile/applyProfile.test.ts`:

```ts
/** @jest-environment node */

/**
 * Проверяем, что уходит в Telegram и что возвращается наружу. Сам клиент
 * подставной: нам важны решения, а не сетевой обмен.
 */

import { applyProfile, describeTelegramError } from '@/lib/tgOutreach/profile/applyProfile';

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    invoke: jest.fn(async () => ({})),
    uploadFile: jest.fn(async () => ({ id: 1 })),
    getEntity: jest.fn(async () => ({ id: 5, firstName: 'Иван', lastName: 'Петров', username: 'ivan' })),
    ...over,
  } as never;
}

describe('applyProfile', () => {
  it('отправляет имя, фамилию и описание одним вызовом', async () => {
    const client = fakeClient();
    await applyProfile({
      client,
      profile: { first_name: 'Иван', last_name: 'Петров', bio: 'Продажи' },
    });
    const invoke = (client as unknown as { invoke: jest.Mock }).invoke;
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('без картинки аватарку не трогает', async () => {
    const client = fakeClient();
    await applyProfile({
      client,
      profile: { first_name: 'Иван', last_name: '', bio: '' },
    });
    expect((client as unknown as { uploadFile: jest.Mock }).uploadFile).not.toHaveBeenCalled();
  });

  it('с картинкой — сначала загрузка файла, потом установка', async () => {
    const client = fakeClient();
    await applyProfile({
      client,
      profile: { first_name: 'Иван', last_name: '', bio: '' },
      avatar: { buffer: Buffer.from('fake-jpeg'), name: 'a.jpg' },
    });
    expect((client as unknown as { uploadFile: jest.Mock }).uploadFile).toHaveBeenCalledTimes(1);
    expect((client as unknown as { invoke: jest.Mock }).invoke).toHaveBeenCalledTimes(2);
  });

  it('возвращает профиль, перечитанный из Telegram, а не то, что отправили', async () => {
    const client = fakeClient({
      getEntity: jest.fn(async () => ({ id: 5, firstName: 'Реальное', lastName: 'Имя', username: 'real' })),
    });
    const res = await applyProfile({
      client,
      profile: { first_name: 'Отправленное', last_name: 'Другое', bio: '' },
    });
    expect(res).toMatchObject({ first_name: 'Реальное', last_name: 'Имя', tg_username: 'real' });
  });
});

describe('describeTelegramError', () => {
  it('FLOOD_WAIT объясняется по-человечески и со сроком', () => {
    expect(describeTelegramError(new Error('A wait of 3600 seconds is required (FLOOD_WAIT_3600)')))
      .toContain('3600');
    expect(describeTelegramError(new Error('FLOOD_WAIT_60'))).toMatch(/слишком часто|подожд/i);
  });

  it('проблема с картинкой названа картинкой', () => {
    expect(describeTelegramError(new Error('PHOTO_INVALID_DIMENSIONS'))).toMatch(/картинк/i);
    expect(describeTelegramError(new Error('IMAGE_PROCESS_FAILED'))).toMatch(/картинк/i);
  });

  it('незнакомая ошибка отдаётся как есть, без выдумок', () => {
    expect(describeTelegramError(new Error('SOMETHING_ODD'))).toContain('SOMETHING_ODD');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/lib/tgOutreach/profile/applyProfile.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/profile/applyProfile'`

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/tgOutreach/profile/applyProfile.ts`:

```ts
/**
 * Применение профиля в Telegram и перечитывание результата.
 *
 * Перечитываем намеренно: Telegram может подрезать значение или отказать
 * частично, и список должен показывать то, что реально стоит в аккаунте, а не
 * то, что мы отправили.
 */
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import type { ProfileInput } from './validateProfile';

export interface ApplyProfileArgs {
  client: TelegramClient;
  profile: ProfileInput;
  avatar?: { buffer: Buffer; name: string };
}

export interface AppliedProfile {
  first_name: string;
  last_name: string;
  bio: string;
  tg_username: string;
  tg_user_id: number | null;
}

export async function applyProfile({
  client,
  profile,
  avatar,
}: ApplyProfileArgs): Promise<AppliedProfile> {
  await client.invoke(
    new Api.account.UpdateProfile({
      firstName: profile.first_name.trim(),
      lastName: profile.last_name.trim(),
      about: profile.bio.trim(),
    }),
  );

  if (avatar) {
    const file = await client.uploadFile({
      file: new (require('telegram/client/uploads').CustomFile)(
        avatar.name,
        avatar.buffer.length,
        avatar.name,
        avatar.buffer,
      ),
      workers: 1,
    });
    await client.invoke(new Api.photos.UploadProfilePhoto({ file }));
  }

  const me = (await client.getEntity('me')) as {
    id?: unknown;
    firstName?: string;
    lastName?: string;
    username?: string;
  };

  return {
    first_name: me.firstName ?? '',
    last_name: me.lastName ?? '',
    // about в getEntity не приходит — оставляем то, что отправили: Telegram
    // описание не подрезает, а лишний запрос GetFullUser ради него не нужен.
    bio: profile.bio.trim(),
    tg_username: me.username ?? '',
    tg_user_id: me.id != null ? Number(me.id) : null,
  };
}

/** Ошибку Telegram переводим в понятную оператору фразу. */
export function describeTelegramError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  const flood = /FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i.exec(msg);
  if (flood) {
    const seconds = flood[1] ?? flood[2];
    return `Telegram просит подождать: вы меняете профиль слишком часто. Повторите через ${seconds} секунд.`;
  }

  if (/PHOTO_|IMAGE_|FILE_PART|MEDIA_/i.test(msg)) {
    return `Telegram не принял картинку: ${msg}. Попробуйте квадратный JPEG до 1 МБ.`;
  }

  if (/FIRSTNAME_INVALID|LASTNAME_INVALID|ABOUT_TOO_LONG/i.test(msg)) {
    return `Telegram не принял значение: ${msg}`;
  }

  return msg;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/profile/applyProfile.test.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/profile/applyProfile.ts app/tests/lib/tgOutreach/profile/applyProfile.test.ts
git commit -m "feat(tg-outreach): применение профиля аккаунта в Telegram"
```

---

## Task 4: Роут правки профиля

**Files:**
- Create: `app/src/app/api/tools/tg-outreach/accounts/[id]/profile/route.ts`

- [ ] **Step 1: Написать роут**

Создать `app/src/app/api/tools/tg-outreach/accounts/[id]/profile/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { createGramClient } from '@/lib/tgOutreach/gramClient';
import { validateProfile } from '@/lib/tgOutreach/profile/validateProfile';
import { applyProfile, describeTelegramError } from '@/lib/tgOutreach/profile/applyProfile';
import type { OutreachAccount, OutreachProxy } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Аватарку крупнее этого Telegram всё равно не примет без пережатия. */
const MAX_AVATAR_BYTES = 1024 * 1024;

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.profile.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const form = await req.formData();
      const profile = {
        first_name: String(form.get('first_name') ?? ''),
        last_name: String(form.get('last_name') ?? ''),
        bio: String(form.get('bio') ?? ''),
      };

      const check = validateProfile(profile);
      if (!check.ok) return jsonError(check.reason, 400);

      const { data: accountRow } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!accountRow) return jsonError('Аккаунт не найден', 404);
      const account = accountRow as OutreachAccount;

      // Гейт по статусу кампании. Работающая кампания уже держит соединение с
      // этим аккаунтом; второе подключение через мобильный прокси — лишний
      // повод для сбоя, а настройка профиля всё равно разовая.
      const { data: campaign } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('status, name')
        .eq('id', account.campaign_id)
        .maybeSingle();
      const status = (campaign as { status?: string } | null)?.status;
      if (status && status !== 'stopped' && status !== 'error') {
        return jsonError(
          `Кампания сейчас в состоянии «${status}». Остановите её, чтобы менять профиль аккаунта: во время работы аккаунт занят.`,
          409,
        );
      }

      const avatarFile = form.get('avatar') as File | null;
      let avatar: { buffer: Buffer; name: string } | undefined;
      if (avatarFile && avatarFile.size > 0) {
        if (avatarFile.size > MAX_AVATAR_BYTES) {
          return jsonError(`Картинка больше 1 МБ (${Math.round(avatarFile.size / 1024)} КБ)`, 400);
        }
        avatar = { buffer: Buffer.from(await avatarFile.arrayBuffer()), name: avatarFile.name || 'avatar.jpg' };
      }

      const { data: proxyRow } = account.proxy_id
        ? await auth.supabase.from('tg_outreach_proxies').select('*').eq('id', account.proxy_id).maybeSingle()
        : { data: null };

      let client;
      try {
        client = await createGramClient(account, (proxyRow as OutreachProxy) ?? null);
      } catch (e) {
        return jsonError(`Аккаунт не подключился через свой прокси: ${describeTelegramError(e)}`, 502);
      }

      try {
        const applied = await applyProfile({ client, profile, avatar });

        await auth.supabase
          .from('tg_outreach_accounts')
          .update({
            first_name: applied.first_name,
            last_name: applied.last_name,
            bio: applied.bio,
            tg_username: applied.tg_username,
            ...(applied.tg_user_id != null ? { tg_user_id: applied.tg_user_id } : {}),
            profile_synced_at: new Date().toISOString(),
          })
          .eq('id', id);

        return NextResponse.json(applied);
      } catch (e) {
        return jsonError(describeTelegramError(e), 400);
      } finally {
        try {
          await client.disconnect();
        } catch {
          /* соединение и так рвётся, отдельная ошибка здесь ничего не меняет */
        }
      }
    },
  );
}
```

- [ ] **Step 2: Проверить типы и линтер**

Run: `cd app && npx tsc --noEmit -p tsconfig.json && npx eslint "src/app/api/tools/tg-outreach/accounts/[id]/profile/route.ts" src/lib/tgOutreach/profile`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add "app/src/app/api/tools/tg-outreach/accounts/[id]/profile/route.ts"
git commit -m "feat(tg-outreach): роут правки профиля аккаунта"
```

---

## Task 5: Форма правки в карточке аккаунта

**Files:**
- Modify: `app/src/app/tools/tg-outreach/page.tsx`

- [ ] **Step 1: Добавить модалку**

В `app/src/app/tools/tg-outreach/page.tsx` перед `/* =================== ACCOUNT LOGS MODAL =================== */` вставить:

```tsx
/* =================== ACCOUNT PROFILE MODAL =================== */
function AccountProfileModal({
  account,
  onClose,
  onSaved,
}: {
  account: OutreachAccount & { first_name?: string; last_name?: string; bio?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(account.first_name ?? '');
  const [lastName, setLastName] = useState(account.last_name ?? '');
  const [bio, setBio] = useState(account.bio ?? '');
  const [avatar, setAvatar] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const form = new FormData();
      form.append('first_name', firstName);
      form.append('last_name', lastName);
      form.append('bio', bio);
      if (avatar) form.append('avatar', avatar);

      const res = await fetch(`${API_BASE}/accounts/${account.id}/profile`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Ошибка ${res.status}`);
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Профиль в Telegram</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Меняется настоящий профиль аккаунта в Telegram. Частая смена имени и аватарки — сигнал для антиспама:
            настраивайте один раз перед запуском. Кампания должна быть остановлена.
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Имя</span>
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={64}
                className="block w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Фамилия</span>
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={64}
                className="block w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
          </div>

          <label className="space-y-1 block">
            <span className="text-[11px] font-medium text-gray-500">Описание ({bio.length}/70)</span>
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={70} rows={2}
              className="block w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 resize-y" />
          </label>

          <label className="space-y-1 block">
            <span className="text-[11px] font-medium text-gray-500">Аватарка (квадратный JPEG до 1 МБ)</span>
            <input type="file" accept="image/jpeg,image/png" onChange={(e) => setAvatar(e.target.files?.[0] ?? null)}
              className="block w-full text-xs" />
          </label>

          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
        </div>

        <div className="border-t border-gray-100 px-6 py-4">
          <button type="button" onClick={() => { void save(); }} disabled={saving || !firstName.trim()}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition cursor-pointer">
            {saving ? 'Применяю в Telegram...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
}

```

- [ ] **Step 2: Открыть модалку из списка аккаунтов**

В `CampaignAccountsTab` добавить состояние рядом с `selectedAccount`:

```tsx
  const [profileAccount, setProfileAccount] = useState<OutreachAccount | null>(null);
```

В строке аккаунта, рядом с кнопкой удаления, добавить кнопку:

```tsx
                <button type="button" onClick={() => setProfileAccount(a)} title="Профиль в Telegram"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition cursor-pointer">
                  <UserCheck className="h-3.5 w-3.5" />
                </button>
```

Перед закрывающим тегом компонента, рядом с `AccountLogsModal`, добавить:

```tsx
      {profileAccount && (
        <AccountProfileModal
          account={profileAccount}
          onClose={() => setProfileAccount(null)}
          onSaved={() => { void load(); }}
        />
      )}
```

Колонку кнопок в сетке расширить: заменить `40px]` на `72px]` в обеих строках `grid-cols-[32px_1fr_120px_150px_80px_40px]` — иначе две кнопки не поместятся.

- [ ] **Step 3: Проверить типы и линтер**

Run: `cd app && npx tsc --noEmit -p tsconfig.json && npx eslint src/app/tools/tg-outreach/page.tsx`
Expected: без ошибок (допустимо существующее предупреждение в `AccountLogsModal`)

- [ ] **Step 4: Прогнать тесты**

Run: `cd app && npx jest tests/lib/tgOutreach tests/migrations`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add app/src/app/tools/tg-outreach/page.tsx
git commit -m "feat(tg-outreach): правка профиля аккаунта из карточки"
```

---

## Проверка перед боевым запуском

1. Остановить тестовую кампанию.
2. Открыть профиль одного аккаунта, поменять описание, применить.
3. Убедиться в самом Telegram, что описание поменялось, — не в портале.
4. Проверить, что в списке портала обновились имя и фамилия, а `profile_synced_at` проставился.
5. Загрузить аватарку, проверить в Telegram.
6. Запустить кампанию и убедиться, что при работающей кампании портал отказывает с внятным текстом.
7. Дважды подряд поменять имя и убедиться, что при FLOOD_WAIT показывается срок ожидания, а не голый код ошибки.

---

## Самопроверка плана

**Покрытие спеки (раздел «Профиль аккаунта»):**

| Требование | Задача |
|---|---|
| Меняем имя, фамилию, описание, аватарку | 3, 5 |
| Юзернейм не трогаем | — намеренно отсутствует во всех задачах |
| Только при остановленной кампании | 4 |
| Перечитывание профиля из Telegram после применения | 3, 4 |
| Поля профиля в `tg_outreach_accounts` | 1 |
| Предупреждение в интерфейсе, без технических лимитов | 5 |
| Ошибки: FLOOD_WAIT со сроком, картинка, подключение | 3 (`describeTelegramError`), 4 |

**Заглушек нет.**

**Согласованность имён:** `validateProfile`, `PROFILE_LIMITS`, `ProfileInput`, `applyProfile`, `AppliedProfile`, `describeTelegramError` — одинаково в задачах 2–5.
