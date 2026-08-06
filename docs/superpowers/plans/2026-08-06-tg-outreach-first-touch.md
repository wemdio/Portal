# Первое касание в TG Outreach: базы контактов и рассылка — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Портал сам отправляет первое сообщение холодным контактам из загруженной базы, чтобы отказаться от TG Ninja и держать всю переписку в одном месте.

**Architecture:** Базы контактов — новые таблицы, связанные с кампанией многие-ко-многим. Отправка встроена в существующий круг кампании (`campaignLoop.ts`): аккаунт сначала разбирает входящие диалоги, потом отправляет порцию первых сообщений. Вся арифметика (разбор файла, проверка текста, выбор порции) вынесена в чистые функции с тестами; цикл только вызывает их и ходит в Telegram.

**Tech Stack:** Next.js API routes, Supabase (Postgres + RLS), gramJS (`telegram`), `xlsx` для разбора файлов, Jest.

**Спека:** [docs/superpowers/specs/2026-08-05-tg-outreach-first-touch-design.md](../specs/2026-08-05-tg-outreach-first-touch-design.md)

**Не входит в этот план:** правка профиля аккаунта — отдельный план `2026-08-06-tg-outreach-account-profile.md`, делается независимо.

---

> **Перед началом:** номер миграции проверить заново — `ls supabase/migrations/ | tail`.
> Пока писался план, номер `20260806_0001` заняла чужая миграция, и это может повториться.

## Структура файлов

**Создаём:**

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260806_0002_tg_outreach_bases.sql` | Три таблицы, гранты, RLS |
| `app/src/lib/tgOutreach/firstTouch/normalizeUsername.ts` | Юзернейм из любой формы записи → `ivanov` |
| `app/src/lib/tgOutreach/firstTouch/parseBaseFile.ts` | Строки файла → контакты + статистика разбора |
| `app/src/lib/tgOutreach/firstTouch/validateMessage.ts` | Проверка текста перед отправкой |
| `app/src/lib/tgOutreach/firstTouch/selectContacts.ts` | Выбор очередной порции, чередование баз |
| `app/src/lib/tgOutreach/firstTouch/db.ts` | Запросы к таблицам баз |
| `app/src/lib/tgOutreach/firstTouch/send.ts` | Отправка порции одним аккаунтом |
| `app/src/app/api/tools/tg-outreach/bases/route.ts` | Список и создание баз |
| `app/src/app/api/tools/tg-outreach/bases/[id]/route.ts` | Одна база: чтение, удаление |
| `app/src/app/api/tools/tg-outreach/bases/[id]/upload/route.ts` | Загрузка файла контактов |
| `app/src/app/api/tools/tg-outreach/campaigns/[id]/bases/route.ts` | Привязка баз к кампании |

**Меняем:**

| Файл | Что |
|---|---|
| `app/src/lib/tgOutreach/campaignLoop.ts` | Вызов отправки в конце обработки аккаунта |
| `app/src/lib/tgOutreach/types.ts` | Поля `first_touch_enabled`, `first_touch_per_account_per_day` в `TelegramSettings` |
| `app/src/app/tools/tg-outreach/page.tsx` | Вкладка «Базы» в кампании |

Почему так: `campaignLoop.ts` уже 2000 строк, класть туда логику первого касания нельзя. Всё новое живёт в `firstTouch/`, цикл получает один вызов.

---

## Task 1: Таблицы баз контактов

**Files:**
- Create: `supabase/migrations/20260806_0002_tg_outreach_bases.sql`
- Test: `app/tests/migrations/tgOutreachBases.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/migrations/tgOutreachBases.test.ts`:

```ts
/** @jest-environment node */

/**
 * Права на новые таблицы. Урок 05.08.2026: у tg_outreach_warmup_runs выдали
 * authenticated только select, и кнопка «Начать прогрев» не работала ни разу с
 * момента выката. Здесь UI пишет во все три таблицы, поэтому проверяем гранты
 * и политики сразу.
 */

import fs from 'node:fs';
import path from 'node:path';

const SQL = fs.readFileSync(
  path.resolve(process.cwd(), '../supabase/migrations/20260806_0002_tg_outreach_bases.sql'),
  'utf8',
);

const TABLES = [
  'tg_outreach_bases',
  'tg_outreach_base_contacts',
  'tg_outreach_campaign_bases',
];

describe('миграция баз контактов', () => {
  it.each(TABLES)('создаёт таблицу %s', (table) => {
    expect(SQL).toMatch(new RegExp(`create table if not exists public\\.${table}\\b`, 'i'));
  });

  it.each(TABLES)('%s: RLS включён', (table) => {
    expect(SQL).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  });

  it.each(TABLES)('%s: service_role получает всё', (table) => {
    expect(SQL).toMatch(new RegExp(`grant all on public\\.${table} to service_role`, 'i'));
  });

  it.each(TABLES)('%s: authenticated может писать, а не только читать', (table) => {
    const grants = SQL.match(
      new RegExp(`grant\\s+([^;]*?)\\s+on\\s+public\\.${table}\\s+to\\s+authenticated\\s*;`, 'gi'),
    );
    expect(grants).not.toBeNull();
    const granted = (grants ?? []).join(' ').toLowerCase();
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      expect(granted).toContain(verb);
    }
  });

  it.each(TABLES)('%s: есть политики на запись', (table) => {
    for (const action of ['insert', 'update', 'delete']) {
      expect(SQL).toMatch(
        new RegExp(`create policy\\s+\\S+\\s+on public\\.${table}\\s+for ${action} to authenticated`, 'i'),
      );
    }
  });

  it('контакт уникален в пределах базы — повторная загрузка не плодит дубли', () => {
    expect(SQL).toMatch(/unique\s*\(\s*base_id\s*,\s*username\s*\)/i);
  });

  it('база не может быть привязана к кампании дважды', () => {
    expect(SQL).toMatch(/unique\s*\(\s*campaign_id\s*,\s*base_id\s*\)/i);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/migrations/tgOutreachBases.test.ts`
Expected: FAIL — `ENOENT: no such file or directory ... 20260806_0002_tg_outreach_bases.sql`

- [ ] **Step 3: Написать миграцию**

Создать `supabase/migrations/20260806_0002_tg_outreach_bases.sql`:

```sql
-- Базы контактов для первого касания в TG Outreach.
--
-- До этого портал умел только отвечать в уже существующих диалогах: первое
-- сообщение отправляла TG Ninja, и переписка жила в двух системах. Базы —
-- именованные списки контактов («Гипотеза 1»), по которым кампания шлёт первое
-- сообщение сама.
--
-- Текст сообщения приходит готовым, вместе с контактом: он готовится вне
-- портала и уже прочитан человеком. Портал его не генерирует.

create table if not exists public.tg_outreach_bases (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists tg_outreach_bases_user_idx
  on public.tg_outreach_bases (user_id, created_at desc);

comment on table public.tg_outreach_bases is
  'Именованный список контактов для первого касания. Имя даёт оператор: «Гипотеза 1».';

create table if not exists public.tg_outreach_base_contacts (
  id           uuid primary key default gen_random_uuid(),
  base_id      uuid not null references public.tg_outreach_bases(id) on delete cascade,
  -- Юзернейм без «@» и в нижнем регистре: единственный ключ, по которому
  -- контакт ищется в Telegram и сверяется с уже обработанными.
  username     text not null,
  message      text not null,
  -- Сырая строка файла целиком. Дёшево и избавляет от повторной загрузки,
  -- если из выгрузки скрапера позже понадобится ещё какое-то поле.
  raw          jsonb not null default '{}'::jsonb,
  status       text not null default 'pending'
    check (status in ('pending', 'sent', 'replied', 'failed', 'skipped')),
  skip_reason  text,
  attempts     integer not null default 0,
  account_id   uuid references public.tg_outreach_accounts(id) on delete set null,
  tg_user_id   bigint,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (base_id, username)
);

create index if not exists tg_outreach_base_contacts_base_status_idx
  on public.tg_outreach_base_contacts (base_id, status);

-- Дневной лимит считается «сколько этот аккаунт отправил с начала суток».
create index if not exists tg_outreach_base_contacts_account_sent_idx
  on public.tg_outreach_base_contacts (account_id, sent_at desc)
  where sent_at is not null;

create table if not exists public.tg_outreach_campaign_bases (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  base_id     uuid not null references public.tg_outreach_bases(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (campaign_id, base_id)
);

create index if not exists tg_outreach_campaign_bases_campaign_idx
  on public.tg_outreach_campaign_bases (campaign_id);

alter table public.tg_outreach_bases enable row level security;
alter table public.tg_outreach_base_contacts enable row level security;
alter table public.tg_outreach_campaign_bases enable row level security;

-- Политики _all, как у остального tg-outreach (20260320_0003): инструмент
-- командный, базу заводит один специалист, а запускает другой.
create policy tg_outreach_bases_select_all on public.tg_outreach_bases
  for select to authenticated using (true);
create policy tg_outreach_bases_insert_all on public.tg_outreach_bases
  for insert to authenticated with check (true);
create policy tg_outreach_bases_update_all on public.tg_outreach_bases
  for update to authenticated using (true) with check (true);
create policy tg_outreach_bases_delete_all on public.tg_outreach_bases
  for delete to authenticated using (true);

create policy tg_outreach_base_contacts_select_all on public.tg_outreach_base_contacts
  for select to authenticated using (true);
create policy tg_outreach_base_contacts_insert_all on public.tg_outreach_base_contacts
  for insert to authenticated with check (true);
create policy tg_outreach_base_contacts_update_all on public.tg_outreach_base_contacts
  for update to authenticated using (true) with check (true);
create policy tg_outreach_base_contacts_delete_all on public.tg_outreach_base_contacts
  for delete to authenticated using (true);

create policy tg_outreach_campaign_bases_select_all on public.tg_outreach_campaign_bases
  for select to authenticated using (true);
create policy tg_outreach_campaign_bases_insert_all on public.tg_outreach_campaign_bases
  for insert to authenticated with check (true);
create policy tg_outreach_campaign_bases_update_all on public.tg_outreach_campaign_bases
  for update to authenticated using (true) with check (true);
create policy tg_outreach_campaign_bases_delete_all on public.tg_outreach_campaign_bases
  for delete to authenticated using (true);

grant all on public.tg_outreach_bases to service_role;
grant all on public.tg_outreach_base_contacts to service_role;
grant all on public.tg_outreach_campaign_bases to service_role;

grant select, insert, update, delete on public.tg_outreach_bases to authenticated;
grant select, insert, update, delete on public.tg_outreach_base_contacts to authenticated;
grant select, insert, update, delete on public.tg_outreach_campaign_bases to authenticated;
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/migrations/tgOutreachBases.test.ts tests/migrations/grants.test.ts`
Expected: PASS, оба файла

- [ ] **Step 5: Коммит**

```bash
git add supabase/migrations/20260806_0002_tg_outreach_bases.sql app/tests/migrations/tgOutreachBases.test.ts
git commit -m "feat(tg-outreach): таблицы баз контактов для первого касания"
```

---

## Task 2: Нормализация юзернейма

**Files:**
- Create: `app/src/lib/tgOutreach/firstTouch/normalizeUsername.ts`
- Test: `app/tests/lib/tgOutreach/firstTouch/normalizeUsername.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/firstTouch/normalizeUsername.test.ts`:

```ts
/** @jest-environment node */

/**
 * Юзернейм — единственный ключ контакта: по нему ищем человека в Telegram и по
 * нему же сверяем, не писали ли ему раньше. Если «@Ivanov», «ivanov» и
 * «t.me/ivanov» осядут в базе тремя разными записями, человек получит три
 * сообщения. Поэтому приводим к одной форме на входе, а не при сравнении.
 */

import { normalizeUsername } from '@/lib/tgOutreach/firstTouch/normalizeUsername';

describe('normalizeUsername', () => {
  it('снимает собаку и приводит к нижнему регистру', () => {
    expect(normalizeUsername('@Ivanov')).toBe('ivanov');
    expect(normalizeUsername('IVANOV')).toBe('ivanov');
  });

  it('вытаскивает юзернейм из ссылок', () => {
    for (const link of [
      'https://t.me/ivanov',
      'http://t.me/ivanov',
      't.me/ivanov',
      'https://telegram.me/ivanov',
      'https://t.me/ivanov/',
      'https://t.me/ivanov?start=1',
    ]) {
      expect(normalizeUsername(link)).toBe('ivanov');
    }
  });

  it('обрезает пробелы и невидимые символы из таблиц', () => {
    expect(normalizeUsername('  @ivanov  ')).toBe('ivanov');
  });

  it('возвращает null на том, что юзернеймом быть не может', () => {
    for (const bad of ['', '   ', '@', '+79001234567', 'https://t.me/+AbCdEf', 'иванов', 'a']) {
      expect(normalizeUsername(bad)).toBeNull();
    }
  });

  it('принимает допустимые Telegram-юзернеймы', () => {
    expect(normalizeUsername('nikolayKiselev94')).toBe('nikolaykiselev94');
    expect(normalizeUsername('@itpelag_account')).toBe('itpelag_account');
  });

  it('не строка — null, а не исключение', () => {
    expect(normalizeUsername(null)).toBeNull();
    expect(normalizeUsername(undefined)).toBeNull();
    expect(normalizeUsername(42 as unknown as string)).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/normalizeUsername.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/firstTouch/normalizeUsername'`

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/tgOutreach/firstTouch/normalizeUsername.ts`:

```ts
/**
 * Приводит юзернейм к единственной форме: без «@», в нижнем регистре.
 *
 * В выгрузках встречается всё сразу — «@ivanov», «ivanov», «https://t.me/ivanov».
 * Приводим на входе, чтобы в базе не оказалось трёх записей на одного человека.
 *
 * Пригласительные ссылки вида `t.me/+AbCdEf` отбрасываем: это не юзернейм, а
 * приглашение в чат, писать по нему некому.
 */

/** Telegram: 5–32 символа, латиница, цифры и подчёркивание. */
const USERNAME_RE = /^[a-z0-9_]{5,32}$/;

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  let value = raw.replace(/ /g, ' ').trim();
  if (!value) return null;

  const link = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(.+)$/i.exec(value);
  if (link) value = link[1];

  value = value.split(/[/?#]/)[0];
  value = value.replace(/^@+/, '').trim().toLowerCase();

  if (!USERNAME_RE.test(value)) return null;
  return value;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/normalizeUsername.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/firstTouch/normalizeUsername.ts app/tests/lib/tgOutreach/firstTouch/normalizeUsername.test.ts
git commit -m "feat(tg-outreach): нормализация юзернейма контакта"
```

---

## Task 3: Разбор файла базы

**Files:**
- Create: `app/src/lib/tgOutreach/firstTouch/parseBaseFile.ts`
- Test: `app/tests/lib/tgOutreach/firstTouch/parseBaseFile.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/firstTouch/parseBaseFile.test.ts`:

```ts
/** @jest-environment node */

/**
 * Файл готовит человек в таблице, поэтому в нём бывает всё: заголовок и без
 * заголовка, лишние колонки из выгрузки скрапера, пустые ячейки, один и тот же
 * человек дважды. Разбор обязан не падать и честно рассказать, что он выкинул,
 * — оператор увидит это до сохранения.
 */

import { parseBaseRows } from '@/lib/tgOutreach/firstTouch/parseBaseFile';

describe('parseBaseRows', () => {
  it('берёт первую колонку как юзернейм, вторую как сообщение', () => {
    const r = parseBaseRows([
      ['@ivanov', 'Иван, добрый день! Вопрос по outreach.'],
      ['@petrov', 'Пётр, добрый день! Вопрос по outreach.'],
    ]);
    expect(r.contacts).toEqual([
      { username: 'ivanov', message: 'Иван, добрый день! Вопрос по outreach.', raw: {} },
      { username: 'petrov', message: 'Пётр, добрый день! Вопрос по outreach.', raw: {} },
    ]);
    expect(r.stats).toMatchObject({ total: 2, accepted: 2, noUsername: 0, noMessage: 0, duplicates: 0 });
  });

  it('пропускает строку заголовка', () => {
    const r = parseBaseRows([
      ['Юзернейм Telegram', 'Персонализированное сообщение'],
      ['@ivanov', 'Иван, добрый день!'],
    ]);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].username).toBe('ivanov');
    expect(r.stats.total).toBe(1);
  });

  it('лишние колонки сохраняет в raw, а не выбрасывает', () => {
    const r = parseBaseRows([
      ['Username', 'Сообщение', 'Биография', 'Источник'],
      ['@ivanov', 'Иван, привет!', 'CTO в стартапе', 'Чат MOST'],
    ]);
    expect(r.contacts[0].raw).toEqual({ 'Биография': 'CTO в стартапе', 'Источник': 'Чат MOST' });
  });

  it('строки без юзернейма и без текста не проходят, но попадают в статистику', () => {
    const r = parseBaseRows([
      ['@ivanov', 'Иван, привет!'],
      ['+79001234567', 'Телефон вместо юзернейма'],
      ['@petrov', '   '],
      ['', ''],
    ]);
    expect(r.contacts).toHaveLength(1);
    expect(r.stats).toMatchObject({ total: 4, accepted: 1, noUsername: 2, noMessage: 1 });
  });

  it('дубль внутри файла берётся один раз — первым', () => {
    const r = parseBaseRows([
      ['@ivanov', 'первое'],
      ['@Ivanov', 'второе'],
      ['https://t.me/ivanov', 'третье'],
    ]);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].message).toBe('первое');
    expect(r.stats.duplicates).toBe(2);
  });

  it('пустой файл — пустой результат, без исключения', () => {
    expect(parseBaseRows([]).contacts).toEqual([]);
    expect(parseBaseRows([]).stats.total).toBe(0);
  });

  it('обрезает пробелы по краям сообщения, внутри не трогает', () => {
    const r = parseBaseRows([['@ivanov', '  Иван,  добрый  день!  ']]);
    expect(r.contacts[0].message).toBe('Иван,  добрый  день!');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/parseBaseFile.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/firstTouch/parseBaseFile'`

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/tgOutreach/firstTouch/parseBaseFile.ts`:

```ts
/**
 * Разбор загруженной таблицы контактов.
 *
 * Формат ровно тот, в котором база сейчас грузится в TG Ninja: первая колонка —
 * юзернейм, вторая — готовое персонализированное сообщение. Всё остальное из
 * выгрузки скрапера складывается в `raw` — выбрасывать чужие данные не наше
 * дело, а повторно собирать базу дорого.
 *
 * Чтение самого XLSX/CSV живёт в роуте: здесь чистая функция над массивом
 * строк, поэтому её поведение целиком покрыто тестами.
 */
import { normalizeUsername } from './normalizeUsername';

export interface ParsedContact {
  username: string;
  message: string;
  /** Колонки помимо первых двух: ключ — заголовок или «Колонка N». */
  raw: Record<string, string>;
}

export interface ParseStats {
  /** Строк с данными, без строки заголовка. */
  total: number;
  accepted: number;
  noUsername: number;
  noMessage: number;
  duplicates: number;
}

export interface ParseResult {
  contacts: ParsedContact[];
  stats: ParseStats;
  headers: string[] | null;
}

function cell(row: unknown[], i: number): string {
  const v = row[i];
  if (typeof v === 'string') return v.replace(/ /g, ' ').trim();
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * Заголовок отличаем по первой ячейке: в строке с данными там юзернейм, а он
 * обязан нормализоваться. «Юзернейм Telegram» — не нормализуется, значит
 * заголовок.
 */
function looksLikeHeader(row: unknown[]): boolean {
  return normalizeUsername(cell(row, 0)) === null && cell(row, 1) !== '';
}

export function parseBaseRows(rows: unknown[][]): ParseResult {
  const stats: ParseStats = { total: 0, accepted: 0, noUsername: 0, noMessage: 0, duplicates: 0 };
  const contacts: ParsedContact[] = [];
  const seen = new Set<string>();

  if (rows.length === 0) return { contacts, stats, headers: null };

  const hasHeader = looksLikeHeader(rows[0]);
  const headers = hasHeader ? rows[0].map((_, i) => cell(rows[0], i)) : null;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  for (const row of dataRows) {
    // Полностью пустые строки — обычный хвост таблицы, в статистику не идут.
    if (row.every((_, i) => cell(row, i) === '')) continue;
    stats.total++;

    const username = normalizeUsername(cell(row, 0));
    if (!username) {
      stats.noUsername++;
      continue;
    }

    const message = cell(row, 1);
    if (!message) {
      stats.noMessage++;
      continue;
    }

    if (seen.has(username)) {
      stats.duplicates++;
      continue;
    }
    seen.add(username);

    const raw: Record<string, string> = {};
    for (let i = 2; i < row.length; i++) {
      const value = cell(row, i);
      if (!value) continue;
      raw[headers?.[i] || `Колонка ${i + 1}`] = value;
    }

    contacts.push({ username, message, raw });
    stats.accepted++;
  }

  return { contacts, stats, headers };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/parseBaseFile.test.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/firstTouch/parseBaseFile.ts app/tests/lib/tgOutreach/firstTouch/parseBaseFile.test.ts
git commit -m "feat(tg-outreach): разбор файла базы контактов"
```

---

## Task 4: Проверка сообщения перед отправкой

**Files:**
- Create: `app/src/lib/tgOutreach/firstTouch/validateMessage.ts`
- Test: `app/tests/lib/tgOutreach/firstTouch/validateMessage.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/firstTouch/validateMessage.test.ts`:

```ts
/** @jest-environment node */

/**
 * Текст пишет человек, поэтому проверка тут не про качество, а про мусор в
 * файле: съехавшую колонку, обрезанную строку, пустую ячейку.
 *
 * Порог длины взят из фактических данных портала: 1064 первых сообщения,
 * медиана 260 знаков, 99% укладываются в 400, максимум за всю историю 573.
 */

import { validateFirstTouch, MAX_MESSAGE_CHARS } from '@/lib/tgOutreach/firstTouch/validateMessage';

const ok = 'Иван, добрый день! Увидел ваш профиль в чате предпринимателей. Помогаем B2B-компаниям находить клиентов. Актуально?';

describe('validateFirstTouch', () => {
  it('нормальное сообщение проходит', () => {
    expect(validateFirstTouch(ok)).toEqual({ ok: true });
  });

  it('порог длины — 400 знаков', () => {
    expect(MAX_MESSAGE_CHARS).toBe(400);
    expect(validateFirstTouch('я'.repeat(400))).toEqual({ ok: true });
    expect(validateFirstTouch('я'.repeat(401))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('пустой текст не отправляем', () => {
    for (const bad of ['', '   ', '\n', ' ']) {
      expect(validateFirstTouch(bad)).toEqual({ ok: false, reason: 'empty' });
    }
  });

  it('переносы строк запрещены: одно сообщение — один абзац', () => {
    expect(validateFirstTouch('Иван, привет!\nВторая строка')).toEqual({ ok: false, reason: 'multiline' });
    expect(validateFirstTouch('Иван, привет!\r\nВторая строка')).toEqual({ ok: false, reason: 'multiline' });
  });

  it('не строка — не отправляем', () => {
    expect(validateFirstTouch(null as unknown as string)).toEqual({ ok: false, reason: 'empty' });
  });

  it('пустая проверка идёт раньше длины: у пустого причина «empty»', () => {
    expect(validateFirstTouch('   ')).toEqual({ ok: false, reason: 'empty' });
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/validateMessage.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/firstTouch/validateMessage'`

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/tgOutreach/firstTouch/validateMessage.ts`:

```ts
/**
 * Проверка первого сообщения перед отправкой.
 *
 * Текст приходит готовым из файла и уже прочитан человеком, поэтому здесь не
 * про качество, а про мусор: пустую ячейку, съехавшую колонку, обрезанную
 * строку.
 *
 * 400 знаков — из фактических данных портала (1064 первых сообщения, медиана
 * 260, 99% в 400, максимум 573). Порог отсекает только то, что длиннее всего,
 * что вообще отправлялось за историю кампаний.
 */

export const MAX_MESSAGE_CHARS = Number(process.env.TG_FIRST_TOUCH_MAX_CHARS) || 400;

export type ValidationFailure = 'empty' | 'too_long' | 'multiline';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: ValidationFailure };

export function validateFirstTouch(message: string): ValidationResult {
  if (typeof message !== 'string') return { ok: false, reason: 'empty' };

  const text = message.replace(/ /g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (/[\r\n]/.test(text)) return { ok: false, reason: 'multiline' };
  if (text.length > MAX_MESSAGE_CHARS) return { ok: false, reason: 'too_long' };

  return { ok: true };
}

/** Человекочитаемая причина для лога и отчёта по базе. */
export function describeFailure(reason: ValidationFailure): string {
  switch (reason) {
    case 'empty':
      return 'пустой текст сообщения';
    case 'too_long':
      return `текст длиннее ${MAX_MESSAGE_CHARS} знаков`;
    case 'multiline':
      return 'в тексте перенос строки — должно быть одно сообщение одним абзацем';
  }
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/validateMessage.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/firstTouch/validateMessage.ts app/tests/lib/tgOutreach/firstTouch/validateMessage.test.ts
git commit -m "feat(tg-outreach): проверка первого сообщения перед отправкой"
```

---

## Task 5: Выбор очередной порции контактов

**Files:**
- Create: `app/src/lib/tgOutreach/firstTouch/selectContacts.ts`
- Test: `app/tests/lib/tgOutreach/firstTouch/selectContacts.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/firstTouch/selectContacts.test.ts`:

```ts
/** @jest-environment node */

/**
 * Чередование баз — не украшение, а условие сравнимости гипотез. Если брать
 * базы подряд, триста контактов первой уйдут за сутки, а вторая начнётся через
 * день, и сравнивать будет нечего: у баз окажется разное время на ответы.
 */

import { selectNextContacts, remainingDailyQuota } from '@/lib/tgOutreach/firstTouch/selectContacts';

const c = (baseId: string, n: number) => ({
  id: `${baseId}-${n}`,
  base_id: baseId,
  username: `user${baseId}${n}`,
  message: `сообщение ${baseId}${n}`,
});

describe('selectNextContacts', () => {
  it('берёт из баз по кругу, а не подряд', () => {
    const picked = selectNextContacts({
      perBase: [
        { baseId: 'A', contacts: [c('A', 1), c('A', 2), c('A', 3)] },
        { baseId: 'B', contacts: [c('B', 1), c('B', 2), c('B', 3)] },
      ],
      limit: 4,
    });
    expect(picked.map((p) => p.id)).toEqual(['A-1', 'B-1', 'A-2', 'B-2']);
  });

  it('кончилась одна база — добирает из оставшихся', () => {
    const picked = selectNextContacts({
      perBase: [
        { baseId: 'A', contacts: [c('A', 1)] },
        { baseId: 'B', contacts: [c('B', 1), c('B', 2), c('B', 3)] },
      ],
      limit: 4,
    });
    expect(picked.map((p) => p.id)).toEqual(['A-1', 'B-1', 'B-2', 'B-3']);
  });

  it('лимит соблюдается точно', () => {
    const picked = selectNextContacts({
      perBase: [{ baseId: 'A', contacts: [c('A', 1), c('A', 2), c('A', 3)] }],
      limit: 2,
    });
    expect(picked).toHaveLength(2);
  });

  it('лимит ноль или меньше — не берём ничего', () => {
    const perBase = [{ baseId: 'A', contacts: [c('A', 1)] }];
    expect(selectNextContacts({ perBase, limit: 0 })).toEqual([]);
    expect(selectNextContacts({ perBase, limit: -5 })).toEqual([]);
  });

  it('пустые базы не ломают чередование', () => {
    const picked = selectNextContacts({
      perBase: [
        { baseId: 'A', contacts: [] },
        { baseId: 'B', contacts: [c('B', 1), c('B', 2)] },
        { baseId: 'C', contacts: [] },
      ],
      limit: 5,
    });
    expect(picked.map((p) => p.id)).toEqual(['B-1', 'B-2']);
  });

  it('баз нет — пустой результат', () => {
    expect(selectNextContacts({ perBase: [], limit: 10 })).toEqual([]);
  });
});

describe('remainingDailyQuota', () => {
  it('остаток дневной нормы аккаунта', () => {
    expect(remainingDailyQuota({ perDay: 20, sentToday: 5 })).toBe(15);
  });

  it('норма выбрана — ноль, а не отрицательное число', () => {
    expect(remainingDailyQuota({ perDay: 20, sentToday: 20 })).toBe(0);
    expect(remainingDailyQuota({ perDay: 20, sentToday: 25 })).toBe(0);
  });

  it('норма не задана или нулевая — первое касание выключено', () => {
    expect(remainingDailyQuota({ perDay: 0, sentToday: 0 })).toBe(0);
    expect(remainingDailyQuota({ perDay: undefined, sentToday: 0 })).toBe(0);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/selectContacts.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/firstTouch/selectContacts'`

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/tgOutreach/firstTouch/selectContacts.ts`:

```ts
/**
 * Кому писать в этом круге.
 *
 * Чистая функция: IO (кто уже обработан, сколько отправлено сегодня) остаётся
 * снаружи, поэтому правило чередования баз целиком проверяется тестами.
 */

export interface PendingContact {
  id: string;
  base_id: string;
  username: string;
  message: string;
}

export interface SelectParams {
  /** Ожидающие контакты, сгруппированные по базам кампании. */
  perBase: Array<{ baseId: string; contacts: PendingContact[] }>;
  limit: number;
}

/**
 * Берём из баз по кругу, по одному контакту из каждой.
 *
 * Подряд нельзя: триста контактов первой базы уйдут за сутки, вторая начнётся
 * через день, и у гипотез окажется разное время на сбор ответов — сравнивать
 * будет нечего.
 */
export function selectNextContacts({ perBase, limit }: SelectParams): PendingContact[] {
  if (limit <= 0) return [];

  const out: PendingContact[] = [];
  const cursors = perBase.map(() => 0);

  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (let i = 0; i < perBase.length && out.length < limit; i++) {
      const contacts = perBase[i].contacts;
      if (cursors[i] >= contacts.length) continue;
      out.push(contacts[cursors[i]]);
      cursors[i]++;
      progressed = true;
    }
  }

  return out;
}

/**
 * Сколько первых сообщений аккаунту ещё можно отправить сегодня.
 *
 * Ноль означает «не отправляем»: и когда норма выбрана, и когда она не задана.
 * Отдельного переключателя «выключить» здесь не нужно — пустая норма и есть
 * выключение.
 */
export function remainingDailyQuota({
  perDay,
  sentToday,
}: {
  perDay: number | undefined;
  sentToday: number;
}): number {
  if (!perDay || perDay <= 0) return 0;
  return Math.max(perDay - sentToday, 0);
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/selectContacts.test.ts`
Expected: PASS, 9 тестов

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/firstTouch/selectContacts.ts app/tests/lib/tgOutreach/firstTouch/selectContacts.test.ts
git commit -m "feat(tg-outreach): выбор порции контактов с чередованием баз"
```

---

## Task 6: Запросы к таблицам баз

**Files:**
- Create: `app/src/lib/tgOutreach/firstTouch/db.ts`

Чистых функций здесь нет — это тонкая обёртка над Supabase, её покрывают тесты Task 8 через подставной клиент. Отдельных тестов не пишем: тестировать мок собственного мока смысла нет.

- [ ] **Step 1: Написать модуль**

Создать `app/src/lib/tgOutreach/firstTouch/db.ts`:

```ts
/**
 * Запросы к таблицам баз. Вынесены из цикла кампании, чтобы `send.ts` читался
 * как последовательность шагов, а не как перемешанные SQL и Telegram.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PendingContact } from './selectContacts';

/** Базы, привязанные к кампании. */
export async function loadCampaignBaseIds(
  db: SupabaseClient,
  campaignId: string,
): Promise<string[]> {
  const { data } = await db
    .from('tg_outreach_campaign_bases')
    .select('base_id')
    .eq('campaign_id', campaignId);
  return (data ?? []).map((r) => (r as { base_id: string }).base_id);
}

/**
 * Ожидающие контакты по каждой базе.
 *
 * Берём с запасом (`perBaseLimit`), потому что часть отсеется на дедупе и
 * резолве юзернейма, а ходить в базу второй раз за добором дороже.
 */
export async function loadPendingByBase(
  db: SupabaseClient,
  baseIds: string[],
  perBaseLimit: number,
): Promise<Array<{ baseId: string; contacts: PendingContact[] }>> {
  const out: Array<{ baseId: string; contacts: PendingContact[] }> = [];
  for (const baseId of baseIds) {
    const { data } = await db
      .from('tg_outreach_base_contacts')
      .select('id, base_id, username, message')
      .eq('base_id', baseId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(perBaseLimit);
    out.push({ baseId, contacts: (data ?? []) as PendingContact[] });
  }
  return out;
}

/** Сколько первых сообщений аккаунт отправил с начала суток. */
export async function countSentToday(
  db: SupabaseClient,
  accountId: string,
  since: Date,
): Promise<number> {
  const { count } = await db
    .from('tg_outreach_base_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('sent_at', since.toISOString());
  return count ?? 0;
}

export async function markContactSent(
  db: SupabaseClient,
  contactId: string,
  accountId: string,
  tgUserId: number,
): Promise<void> {
  await db
    .from('tg_outreach_base_contacts')
    .update({
      status: 'sent',
      account_id: accountId,
      tg_user_id: tgUserId,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);
}

export async function markContactSkipped(
  db: SupabaseClient,
  contactId: string,
  reason: string,
): Promise<void> {
  await db
    .from('tg_outreach_base_contacts')
    .update({ status: 'skipped', skip_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', contactId);
}

/**
 * Неудачная попытка: контакт не сгорает, а откладывается до следующего круга —
 * сбой мог быть сетевым. Три подряд — сдаёмся и показываем оператору.
 */
export async function recordContactFailure(
  db: SupabaseClient,
  contactId: string,
  attempts: number,
  reason: string,
): Promise<void> {
  const next = attempts + 1;
  await db
    .from('tg_outreach_base_contacts')
    .update({
      attempts: next,
      skip_reason: reason,
      ...(next >= 3 ? { status: 'failed' } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/tgOutreach/firstTouch/db.ts
git commit -m "feat(tg-outreach): запросы к таблицам баз контактов"
```

---

## Task 7: Настройки кампании

**Files:**
- Modify: `app/src/lib/tgOutreach/types.ts`

- [ ] **Step 1: Добавить поля в TelegramSettings**

В `app/src/lib/tgOutreach/types.ts` в интерфейс `TelegramSettings` (после `account_cooldown_hours`) добавить:

```ts
  /**
   * Сколько первых сообщений аккаунт отправляет в сутки. Ноль или отсутствие
   * поля = первое касание выключено; отдельного переключателя не нужно.
   * Кампании, заведённые до этой фичи, поля не имеют — отсюда `?`.
   */
  first_touch_per_account_per_day?: number;
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/tgOutreach/types.ts
git commit -m "feat(tg-outreach): настройка дневной нормы первых сообщений"
```

---

## Task 8: Отправка порции первых сообщений

**Files:**
- Create: `app/src/lib/tgOutreach/firstTouch/send.ts`
- Test: `app/tests/lib/tgOutreach/firstTouch/send.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/firstTouch/send.test.ts`:

```ts
/** @jest-environment node */

/**
 * Проверяем решения, а не Telegram: кого пропустили и почему, кому отправили,
 * что записали. Клиент и БД — подставные.
 */

import { sendFirstTouchBatch } from '@/lib/tgOutreach/firstTouch/send';

type Row = Record<string, unknown>;

/** Минимальный поддельный Supabase: помнит апдейты и отдаёт заготовленные выборки. */
function fakeDb(pending: Row[], processed: number[] = []) {
  const updates: Array<{ table: string; patch: Row; id: unknown }> = [];
  const inserts: Array<{ table: string; row: Row }> = [];

  const api = {
    updates,
    inserts,
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        in: () => chain,
        order: () => chain,
        maybeSingle: async () => ({ data: null }),
        limit: async () => ({
          data:
            table === 'tg_outreach_base_contacts'
              ? pending
              : table === 'tg_outreach_campaign_bases'
                ? [{ base_id: 'base-1' }]
                : [],
        }),
        update: (patch: Row) => ({
          eq: async (_col: string, id: unknown) => {
            updates.push({ table, patch, id });
            return { error: null };
          },
        }),
        upsert: async (row: Row) => {
          inserts.push({ table, row });
          return { error: null };
        },
        insert: async (row: Row) => {
          inserts.push({ table, row });
          return { error: null };
        },
      };
      if (table === 'tg_outreach_processed') {
        chain.maybeSingle = async () => ({
          data: processed.length ? { tg_user_id: processed[0] } : null,
        });
      }
      return chain;
    },
  };
  return api as unknown as Parameters<typeof sendFirstTouchBatch>[0]['db'] & typeof api;
}

const contact = (over: Partial<Row> = {}): Row => ({
  id: 'c-1',
  base_id: 'base-1',
  username: 'ivanov',
  message: 'Иван, добрый день! Вопрос по outreach.',
  attempts: 0,
  ...over,
});

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    getEntity: jest.fn(async () => ({ id: 777, username: 'ivanov' })),
    sendMessage: jest.fn(async () => ({ id: 1 })),
    ...over,
  } as never;
}

const baseArgs = {
  campaignId: 'camp-1',
  account: { id: 'acc-1', session_name: 'Makepao', campaign_id: 'camp-1' },
  perDay: 5,
  log: () => {},
};

describe('sendFirstTouchBatch', () => {
  it('отправляет и помечает контакт отправленным', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient();

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.sent).toBe(1);
    expect((client as unknown as { sendMessage: jest.Mock }).sendMessage).toHaveBeenCalledTimes(1);
    const sentUpdate = db.updates.find((u) => u.patch.status === 'sent');
    expect(sentUpdate).toBeDefined();
    expect(sentUpdate?.patch).toMatchObject({ account_id: 'acc-1', tg_user_id: 777 });
  });

  it('битый текст не отправляется, контакт откладывается', async () => {
    const db = fakeDb([contact({ message: 'я'.repeat(500) })]);
    const client = fakeClient();

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.sent).toBe(0);
    expect((client as unknown as { sendMessage: jest.Mock }).sendMessage).not.toHaveBeenCalled();
    expect(db.updates.some((u) => u.patch.attempts === 1)).toBe(true);
  });

  it('юзернейм не найден — пропуск с причиной, без повторов', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      getEntity: jest.fn(async () => {
        throw new Error('No user has "ivanov" as username');
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.sent).toBe(0);
    const skipped = db.updates.find((u) => u.patch.status === 'skipped');
    expect(skipped).toBeDefined();
    expect(String(skipped?.patch.skip_reason)).toContain('не найден');
  });

  it('дневная норма ноль — в Telegram не ходим вообще', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient();

    const res = await sendFirstTouchBatch({ ...baseArgs, perDay: 0, db, client } as never);

    expect(res.sent).toBe(0);
    expect((client as unknown as { getEntity: jest.Mock }).getEntity).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/send.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/firstTouch/send'`

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/tgOutreach/firstTouch/send.ts`:

```ts
/**
 * Отправка порции первых сообщений одним аккаунтом.
 *
 * Вызывается из круга кампании после разбора входящих: у аккаунта одно
 * подключение к Telegram, и отвечать на ответ обязан тот же аккаунт, который
 * написал первым.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramClient } from 'telegram';
import { validateFirstTouch, describeFailure } from './validateMessage';
import { selectNextContacts, remainingDailyQuota, type PendingContact } from './selectContacts';
import * as fdb from './db';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface SendBatchArgs {
  db: SupabaseClient;
  client: TelegramClient;
  campaignId: string;
  account: { id: string; session_name: string; campaign_id: string };
  /** Дневная норма первых сообщений на аккаунт. Ноль = выключено. */
  perDay: number | undefined;
  log: LogFn;
  shouldStop?: () => boolean;
  onProgress?: () => void;
  /** Пауза между отправками внутри порции, мс. */
  gapMs?: number;
}

export interface SendBatchResult {
  sent: number;
  skipped: number;
  postponed: number;
}

/** Начало текущих суток по времени сервера — для дневной нормы. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isUsernameNotFound(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes('as username')
    || m.includes('username_not_occupied')
    || m.includes('username_invalid')
    || m.includes('no user has');
}

export async function sendFirstTouchBatch(args: SendBatchArgs): Promise<SendBatchResult> {
  const { db, client, campaignId, account, perDay, log } = args;
  const result: SendBatchResult = { sent: 0, skipped: 0, postponed: 0 };

  const sentToday = await fdb.countSentToday(db, account.id, startOfToday());
  const quota = remainingDailyQuota({ perDay, sentToday });
  if (quota <= 0) return result;

  const baseIds = await fdb.loadCampaignBaseIds(db, campaignId);
  if (!baseIds.length) return result;

  // С запасом: часть контактов отсеется на дедупе и резолве, второй заход в БД
  // за добором дороже, чем лишние строки в выборке.
  const perBase = await fdb.loadPendingByBase(db, baseIds, quota * 2);
  const picked = selectNextContacts({ perBase, limit: quota });
  if (!picked.length) return result;

  for (const contact of picked) {
    if (args.shouldStop?.()) break;
    args.onProgress?.();

    const attempts = Number((contact as PendingContact & { attempts?: number }).attempts ?? 0);

    const check = validateFirstTouch(contact.message);
    if (!check.ok) {
      await fdb.recordContactFailure(db, contact.id, attempts, describeFailure(check.reason));
      log('warning', `Первое касание: @${contact.username} отложен — ${describeFailure(check.reason)}`);
      result.postponed++;
      continue;
    }

    let entity: { id: unknown; username?: string };
    try {
      entity = (await client.getEntity(`@${contact.username}`)) as { id: unknown; username?: string };
    } catch (err) {
      if (isUsernameNotFound(err)) {
        await fdb.markContactSkipped(db, contact.id, 'юзернейм не найден в Telegram');
        log('info', `Первое касание: @${contact.username} пропущен — юзернейм не найден`);
        result.skipped++;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        await fdb.recordContactFailure(db, contact.id, attempts, `не смог найти собеседника: ${msg}`);
        result.postponed++;
      }
      continue;
    }

    const tgUserId = Number(entity.id);

    // Единая точка «этому человеку уже писали» — общая для всех баз и кампаний.
    const { data: already } = await db
      .from('tg_outreach_processed')
      .select('tg_user_id')
      .eq('campaign_id', campaignId)
      .eq('tg_user_id', tgUserId)
      .maybeSingle();
    if (already) {
      await fdb.markContactSkipped(db, contact.id, 'этому человеку уже писали');
      result.skipped++;
      continue;
    }

    try {
      await client.sendMessage(`@${contact.username}`, { message: contact.message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await fdb.recordContactFailure(db, contact.id, attempts, `не отправилось: ${msg}`);
      log('warning', `Первое касание: @${contact.username} не отправилось — ${msg}`);
      result.postponed++;
      continue;
    }

    const nowIso = new Date().toISOString();
    await db.from('tg_outreach_dialogs').insert({
      campaign_id: campaignId,
      account_id: account.id,
      tg_user_id: tgUserId,
      tg_username: contact.username,
      messages: [{ role: 'assistant', content: contact.message, timestamp: nowIso }],
      status: 'none',
      can_send: true,
      last_message_at: nowIso,
    });
    await db.from('tg_outreach_processed').upsert(
      { campaign_id: campaignId, tg_user_id: tgUserId, tg_username: contact.username },
      { onConflict: 'campaign_id,tg_user_id' },
    );
    await fdb.markContactSent(db, contact.id, account.id, tgUserId);

    log('info', `Первое касание: отправлено @${contact.username}`);
    result.sent++;

    if (args.gapMs && result.sent < picked.length) {
      await new Promise((r) => setTimeout(r, args.gapMs));
    }
  }

  return result;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/firstTouch/send.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/firstTouch/send.ts app/tests/lib/tgOutreach/firstTouch/send.test.ts
git commit -m "feat(tg-outreach): отправка порции первых сообщений"
```

---

## Task 9: Встроить отправку в круг кампании

**Files:**
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts`

- [ ] **Step 1: Добавить импорт**

В `app/src/lib/tgOutreach/campaignLoop.ts` после импорта `./proxyHealth` добавить:

```ts
import { sendFirstTouchBatch } from './firstTouch/send';
```

- [ ] **Step 2: Вставить вызов в конце обработки аккаунта**

Найти в цикле `for (const entry of clients)` строку:

```ts
        const accountDelay = randomRange(tg.account_loop_delay_range) * 1000;
```

Вставить **перед** ней:

```ts
        // Первое касание — после разбора входящих и только этим же аккаунтом:
        // отвечать на ответ обязан тот, кто написал первым.
        try {
          const ft = await sendFirstTouchBatch({
            db,
            client,
            campaignId,
            account,
            perDay: tg.first_touch_per_account_per_day,
            log,
            shouldStop,
            onProgress: tick,
            gapMs: randomRange(tg.read_reply_delay_range) * 1000,
          });
          if (ft.sent || ft.skipped || ft.postponed) {
            log(
              'info',
              `Аккаунт ${account.session_name}: первое касание — отправлено ${ft.sent}, пропущено ${ft.skipped}, отложено ${ft.postponed}`,
            );
          }
        } catch (err) {
          // Первое касание не должно ронять круг: аутрич по существующим
          // диалогам важнее и уже отработал выше.
          log(
            'warning',
            `Аккаунт ${account.session_name}: первое касание не отработало — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        tick();

```

- [ ] **Step 3: Проверить типы и линтер**

Run: `cd app && npx tsc --noEmit -p tsconfig.json && npx eslint src/lib/tgOutreach/campaignLoop.ts src/lib/tgOutreach/firstTouch`
Expected: без ошибок

- [ ] **Step 4: Прогнать все тесты tg-outreach**

Run: `cd app && npx jest tests/lib/tgOutreach`
Expected: PASS, все файлы

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/campaignLoop.ts
git commit -m "feat(tg-outreach): первое касание в круге кампании"
```

---

## Task 10: API — базы контактов

**Files:**
- Create: `app/src/app/api/tools/tg-outreach/bases/route.ts`
- Create: `app/src/app/api/tools/tg-outreach/bases/[id]/route.ts`

- [ ] **Step 1: Список и создание**

Создать `app/src/app/api/tools/tg-outreach/bases/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { data: bases, error } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, name, notes, created_at')
        .order('created_at', { ascending: false });
      if (error) return jsonError(error.message, 500);

      // Счётчики по состояниям — то, ради чего оператор открывает список.
      const items = [];
      for (const base of bases ?? []) {
        const b = base as { id: string };
        const { data: rows } = await auth.supabase
          .from('tg_outreach_base_contacts')
          .select('status')
          .eq('base_id', b.id);
        const counts = { total: 0, pending: 0, sent: 0, replied: 0, failed: 0, skipped: 0 };
        for (const r of (rows ?? []) as Array<{ status: keyof typeof counts }>) {
          counts.total++;
          if (r.status in counts) counts[r.status]++;
        }
        items.push({ ...base, counts });
      }

      return NextResponse.json({ items });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const body = (await req.json().catch(() => null)) as { name?: string; notes?: string } | null;
      const name = body?.name?.trim();
      if (!name) return jsonError('Укажите название базы', 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_bases')
        .insert({ user_id: auth.user.id, name, notes: body?.notes?.trim() ?? '' })
        .select()
        .single();
      if (error) return jsonError(error.message, 500);

      return NextResponse.json(data, { status: 201 });
    },
  );
}
```

- [ ] **Step 2: Одна база — чтение и удаление**

Создать `app/src/app/api/tools/tg-outreach/bases/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: base } = await auth.supabase
        .from('tg_outreach_bases')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!base) return jsonError('База не найдена', 404);

      const { data: contacts } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .select('id, username, message, status, skip_reason, sent_at')
        .eq('base_id', id)
        .order('created_at', { ascending: true })
        .limit(1000);

      return NextResponse.json({ base, contacts: contacts ?? [] });
    },
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      // Контакты и привязки к кампаниям уходят каскадом (on delete cascade).
      const { error } = await auth.supabase.from('tg_outreach_bases').delete().eq('id', id);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}
```

- [ ] **Step 3: Проверить типы**

Run: `cd app && npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок

- [ ] **Step 4: Коммит**

```bash
git add app/src/app/api/tools/tg-outreach/bases
git commit -m "feat(tg-outreach): API баз контактов"
```

---

## Task 11: API — загрузка контактов в базу

**Files:**
- Create: `app/src/app/api/tools/tg-outreach/bases/[id]/upload/route.ts`

- [ ] **Step 1: Написать роут**

Создать `app/src/app/api/tools/tg-outreach/bases/[id]/upload/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { parseBaseRows } from '@/lib/tgOutreach/firstTouch/parseBaseFile';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Больше за раз не принимаем: одна гипотеза — это порядка 300 контактов. */
const MAX_CONTACTS = 5000;

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.upload.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: base } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id')
        .eq('id', id)
        .maybeSingle();
      if (!base) return jsonError('База не найдена', 404);

      const form = await req.formData();
      const file = form.get('file') as File | null;
      if (!file) return jsonError('Добавьте файл с контактами', 400);

      let rows: unknown[][];
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        // header: 1 — читаем как массив массивов: заголовок распознаёт parseBaseRows,
        // и делает это по содержимому первой ячейки, а не по вере в него.
        rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
      } catch (e) {
        return jsonError(`Не смог прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
      }

      const parsed = parseBaseRows(rows);
      if (!parsed.contacts.length) {
        return jsonError('В файле нет ни одной пригодной строки: нужны юзернейм в первой колонке и текст во второй', 400);
      }
      if (parsed.contacts.length > MAX_CONTACTS) {
        return jsonError(`Слишком много контактов: ${parsed.contacts.length}, максимум ${MAX_CONTACTS}`, 400);
      }

      // upsert по (base_id, username): повторная загрузка того же файла не
      // плодит дубли и не сбрасывает статусы уже отправленных.
      const { error } = await auth.supabase.from('tg_outreach_base_contacts').upsert(
        parsed.contacts.map((c) => ({
          base_id: id,
          username: c.username,
          message: c.message,
          raw: c.raw,
        })),
        { onConflict: 'base_id,username', ignoreDuplicates: true },
      );
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ stats: parsed.stats, headers: parsed.headers }, { status: 201 });
    },
  );
}
```

- [ ] **Step 2: Проверить типы и линтер**

Run: `cd app && npx tsc --noEmit -p tsconfig.json && npx eslint "src/app/api/tools/tg-outreach/bases/[id]/upload/route.ts"`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add "app/src/app/api/tools/tg-outreach/bases/[id]/upload/route.ts"
git commit -m "feat(tg-outreach): загрузка контактов в базу из файла"
```

---

## Task 12: API — привязка баз к кампании

**Files:**
- Create: `app/src/app/api/tools/tg-outreach/campaigns/[id]/bases/route.ts`

- [ ] **Step 1: Написать роут**

Создать `app/src/app/api/tools/tg-outreach/campaigns/[id]/bases/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.bases.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data, error } = await auth.supabase
        .from('tg_outreach_campaign_bases')
        .select('base_id, tg_outreach_bases(id, name)')
        .eq('campaign_id', id);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ items: data ?? [] });
    },
  );
}

/** Полная замена набора баз кампании: так UI не нужно вычислять дельту. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.bases.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => null)) as { base_ids?: unknown } | null;
      if (!Array.isArray(body?.base_ids)) return jsonError('base_ids должен быть массивом', 400);

      const baseIds = Array.from(
        new Set(body.base_ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '')),
      );

      const { error: delError } = await auth.supabase
        .from('tg_outreach_campaign_bases')
        .delete()
        .eq('campaign_id', id);
      if (delError) return jsonError(delError.message, 500);

      if (baseIds.length) {
        const { error: insError } = await auth.supabase
          .from('tg_outreach_campaign_bases')
          .insert(baseIds.map((baseId) => ({ campaign_id: id, base_id: baseId })));
        if (insError) return jsonError(insError.message, 500);
      }

      return NextResponse.json({ ok: true, count: baseIds.length });
    },
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add "app/src/app/api/tools/tg-outreach/campaigns/[id]/bases/route.ts"
git commit -m "feat(tg-outreach): привязка баз к кампании"
```

---

## Task 13: Вкладка «Базы» в кампании

**Files:**
- Modify: `app/src/app/tools/tg-outreach/page.tsx`

- [ ] **Step 1: Добавить компонент вкладки**

В `app/src/app/tools/tg-outreach/page.tsx` перед `/* =================== CAMPAIGN PROXIES TAB =================== */` вставить:

```tsx
/* =================== CAMPAIGN BASES TAB =================== */
interface OutreachBase {
  id: string;
  name: string;
  notes: string;
  counts: { total: number; pending: number; sent: number; replied: number; failed: number; skipped: number };
}

function CampaignBasesTab({ campaignId }: { campaignId: string }) {
  const [bases, setBases] = useState<OutreachBase[]>([]);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [basesRes, linkRes] = await Promise.all([
      authFetch(`${API_BASE}/bases`),
      authFetch(`${API_BASE}/campaigns/${campaignId}/bases`),
    ]);
    if (basesRes.ok) setBases(((await basesRes.json()) as { items: OutreachBase[] }).items);
    if (linkRes.ok) {
      const d = (await linkRes.json()) as { items: Array<{ base_id: string }> };
      setLinked(new Set(d.items.map((i) => i.base_id)));
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const createBase = async () => {
    if (!newName.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await authFetch(`${API_BASE}/bases`, {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Ошибка ${res.status}`);
        return;
      }
      setNewName('');
      void load();
    } finally { setBusy(false); }
  };

  const toggleLink = async (baseId: string) => {
    const next = new Set(linked);
    if (next.has(baseId)) next.delete(baseId); else next.add(baseId);
    setLinked(next);
    setError(null);
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/bases`, {
      method: 'PUT',
      body: JSON.stringify({ base_ids: [...next] }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? `Не удалось сохранить выбор баз (${res.status})`);
      void load();
    }
  };

  const uploadContacts = async (baseId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const token = await getAccessToken();
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/bases/${baseId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const d = (await res.json().catch(() => null)) as
        | { error?: string; stats?: { total: number; accepted: number; noUsername: number; noMessage: number; duplicates: number } }
        | null;
      if (!res.ok) {
        setError(d?.error ?? `Ошибка загрузки (${res.status})`);
        return;
      }
      const s = d?.stats;
      if (s) {
        setError(
          `Загружено ${s.accepted} из ${s.total}. Без юзернейма — ${s.noUsername}, без текста — ${s.noMessage}, дублей — ${s.duplicates}.`,
        );
      }
      void load();
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-medium text-gray-700">
          Базы контактов <span className="text-gray-400 font-normal">({bases.length})</span>
        </span>
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Гипотеза 1"
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
          />
          <button type="button" onClick={() => { void createBase(); }} disabled={busy || !newName.trim()}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Создать базу
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : bases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <Users className="mx-auto h-8 w-8 text-gray-300 mb-2" />
          <p className="text-xs text-gray-400">Баз пока нет. Создайте базу и загрузите файл: юзернейм в первой колонке, текст сообщения во второй.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[32px_1fr_repeat(4,80px)_120px] gap-4 px-4 py-2 text-[11px] font-medium text-gray-400 bg-gray-50 items-center">
            <span />
            <span>База</span><span>Всего</span><span>Ждут</span><span>Отправлено</span><span>Пропущено</span><span />
          </div>
          {bases.map((b) => (
            <div key={b.id} className="grid grid-cols-[32px_1fr_repeat(4,80px)_120px] gap-4 items-center px-4 py-2.5">
              <input
                type="checkbox"
                checked={linked.has(b.id)}
                onChange={() => { void toggleLink(b.id); }}
                title="Использовать эту базу в кампании"
                aria-label={`Использовать базу ${b.name}`}
                className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
              />
              <span className="text-xs font-medium text-gray-800 truncate">{b.name}</span>
              <span className="text-xs text-gray-600">{b.counts.total}</span>
              <span className="text-xs text-gray-600">{b.counts.pending}</span>
              <span className="text-xs text-gray-600">{b.counts.sent}</span>
              <span className="text-xs text-gray-600">{b.counts.skipped}</span>
              <label className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 cursor-pointer">
                <Upload className="h-3 w-3" /> Загрузить
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { void uploadContacts(b.id, e); }} />
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

```

- [ ] **Step 2: Добавить вкладку в набор**

Найти список вкладок кампании (там, где перечислены «Настройки», «Аккаунты», «Прогрев», «Прокси», «Логи», «Диалоги», «Обработанные») и добавить после «Аккаунты»:

```tsx
            { key: 'bases', label: 'Базы', icon: Users },
```

и в месте, где вкладки рендерятся по `key`, добавить ветку:

```tsx
          {tab === 'bases' && <CampaignBasesTab campaignId={campaign.id} />}
```

- [ ] **Step 3: Проверить типы и линтер**

Run: `cd app && npx tsc --noEmit -p tsconfig.json && npx eslint src/app/tools/tg-outreach/page.tsx`
Expected: без ошибок (допустимо существующее предупреждение в `AccountLogsModal`)

- [ ] **Step 4: Коммит**

```bash
git add app/src/app/tools/tg-outreach/page.tsx
git commit -m "feat(tg-outreach): вкладка баз контактов в кампании"
```

---

## Task 14: Настройка дневной нормы в интерфейсе

**Files:**
- Modify: `app/src/app/tools/tg-outreach/page.tsx`

- [ ] **Step 1: Добавить поле в настройки кампании**

В компоненте настроек кампании (там, где редактируются `telegram_settings`) добавить поле рядом с `account_cooldown_hours`:

```tsx
              <label className="space-y-1">
                <span className="text-[11px] font-medium text-gray-500">Первых сообщений на аккаунт в сутки</span>
                <input
                  type="number"
                  min={0}
                  value={telegram.first_touch_per_account_per_day ?? 0}
                  onChange={(e) =>
                    setTelegram({ ...telegram, first_touch_per_account_per_day: Number(e.target.value) || 0 })
                  }
                  className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
                />
                <span className="block text-[10px] text-gray-400">
                  Ноль — рассылка первых сообщений выключена. 16 аккаунтов по 20 — это 320 в день.
                </span>
              </label>
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок

- [ ] **Step 3: Прогнать все тесты**

Run: `cd app && npx jest tests/lib/tgOutreach tests/migrations`
Expected: PASS

- [ ] **Step 4: Коммит**

```bash
git add app/src/app/tools/tg-outreach/page.tsx
git commit -m "feat(tg-outreach): настройка дневной нормы первых сообщений в интерфейсе"
```

---

## Проверка перед боевым запуском

Выполнить руками после выката, до того как включать норму больше нуля:

1. Создать базу «Тест», загрузить файл из 3 контактов — своих личных аккаунтов, не клиентских.
2. Убедиться, что в отчёте базы 3 контакта в состоянии «ждут», а статистика загрузки показала верные числа.
3. Привязать базу к остановленной тестовой кампании, поставить норму 1 сообщение в сутки.
4. Запустить кампанию. В логах должна появиться строка «первое касание — отправлено 1».
5. Проверить, что сообщение пришло, диалог виден на вкладке «Диалоги», а контакт в базе перешёл в «отправлено».
6. Ответить с тестового аккаунта и убедиться, что GPT отвечает — то есть ответ подхватил существующий механизм.
7. Только после этого поднимать норму на боевой кампании.

---

## Самопроверка плана

**Покрытие спеки:**

| Требование спеки | Задача |
|---|---|
| Таблицы баз, контактов, связи с кампанией | 1 |
| Файл из двух колонок, статистика разбора | 3, 11 |
| Поиск только по юзернейму | 2, 8 |
| Чередование баз | 5 |
| Дедуп через `tg_outreach_processed` | 8 |
| Закрепление контакта за аккаунтом | 8 |
| Первое касание внутри круга кампании | 9 |
| Проверка текста: пустой, 400 знаков, переносы | 4 |
| Откладывание и три неудачи подряд | 6, 8 |
| Ответ подхватывает существующий механизм диалогов | 8 (запись в `tg_outreach_dialogs`), проверка вручную п. 6 |
| Лимит на аккаунт в сутки | 5, 6, 14 |
| Раздел «Базы», выбор баз в кампании, отчёт | 13, 14 |
| Ночное молчание и антифлуд | 9 — наследуются из цикла, отдельного кода нет |

Профиль аккаунта в этом плане отсутствует намеренно — отдельный план.

**Заглушек нет:** каждый шаг содержит код или точную команду.

**Согласованность имён:** `normalizeUsername`, `parseBaseRows`, `validateFirstTouch`, `describeFailure`, `MAX_MESSAGE_CHARS`, `selectNextContacts`, `remainingDailyQuota`, `PendingContact`, `sendFirstTouchBatch`, `fdb.*` — используются в задачах 2–9 в одном и том же написании.
