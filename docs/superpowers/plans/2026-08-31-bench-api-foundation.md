# Bench API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить основание внешней витрины `/api/bench/v1/` — ключи, изоляцию, лимиты, журнал, каталог инструментов — и довести до конца два эталонных адаптера (задачный `yandexmaps` и поисковый `company-base`), доказывающих обе формы контракта.

**Architecture:** Тонкая витрина поверх существующих таблиц задач. Ключ из заголовка `Authorization` ищется по SHA-256-отпечатку в `bench_api_keys`, оттуда берётся учётка-робот; витрина выпускает короткоживущий HS256-токен робота и ходит в базу **от его имени**, поэтому чужие строки не отдаёт сама БД. Каждый инструмент описан декларативным адаптером (схема параметров на zod, построение строки задачи, перевод статуса, координаты таблицы результатов); роуты не знают про инструменты ничего, кроме реестра.

**Tech Stack:** Next.js App Router, TypeScript, Supabase (Postgres + RLS), zod 4, Jest, `node:crypto` (без новых зависимостей).

**Спека:** [`docs/superpowers/specs/2026-08-30-bench-api-design.md`](../specs/2026-08-30-bench-api-design.md)

---

## Область этого плана

**Входит:** миграция, ключи, токен робота, изоляция, лимиты, журнал, единая форма ошибок, реестр инструментов, роуты `/tools` `/jobs` `/jobs/{id}` `/jobs/{id}/results` `/jobs/{id}/stop` `/search`, адаптеры `yandexmaps` и `company-base`, правка middleware.

**Следующим планом:** остальные 10 задачных адаптеров, 2 поисковых, экран в админке, документация. Их пишем после того, как эталонная пара ляжет в код — по живому образцу, а не по догадке о нём.

## Отклонения от спеки, зафиксированные при планировании

1. **Стоп доступен не везде.** Из 12 задачных инструментов остановку поддерживают только `googlemaps` и `googlenews`. У остальных нет ни ручки остановки, ни статуса «остановлена» в ограничении таблицы (`check (status in ('pending','running','completed','failed'))`). Добавлять их — значит менять миграции и воркеры девяти работающих инструментов. Вместо этого каждый адаптер **декларирует** поддержку стопа, `/tools` её публикует, а `POST /stop` на неподдерживающий инструмент отвечает `conflict` с человеческой причиной.
2. **`yandexmaps` в v1 принимает только `search_urls`.** Второй режим (поиск по каталогу) внутри ручки ветвится на «выполнить сразу» и «поставить в очередь» в зависимости от объёма, и по смыслу это поиск по нашей базе, а не парсинг. Он относится к поисковой форме и будет добавлен вместе с остальными поисковыми источниками.

## Структура файлов

**Создать:**

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260831_0001_bench_api.sql` | таблицы ключей и журнала, флаг робота |
| `app/src/lib/bench/types.ts` | типы контракта и адаптеров |
| `app/src/lib/bench/errors.ts` | коды ошибок и единая форма ответа |
| `app/src/lib/bench/keys.ts` | генерация, отпечаток, последние 4 символа |
| `app/src/lib/bench/robotToken.ts` | выпуск HS256-токена робота |
| `app/src/lib/bench/db.ts` | клиент, привязанный к владельцу |
| `app/src/lib/bench/auth.ts` | проверка ключа → `{ key, db }` |
| `app/src/lib/bench/limits.ts` | rpm, суточные нормы, потолок активных |
| `app/src/lib/bench/journal.ts` | запись обращения в журнал |
| `app/src/lib/bench/registry.ts` | реестр инструментов и выборка по ключу |
| `app/src/lib/bench/tools/yandexmaps.ts` | эталонный задачный адаптер |
| `app/src/lib/bench/tools/companyBase.ts` | эталонный поисковый адаптер |
| `app/src/app/api/bench/v1/tools/route.ts` | каталог |
| `app/src/app/api/bench/v1/jobs/route.ts` | постановка и список |
| `app/src/app/api/bench/v1/jobs/[id]/route.ts` | статус одной задачи |
| `app/src/app/api/bench/v1/jobs/[id]/results/route.ts` | результаты страницами |
| `app/src/app/api/bench/v1/jobs/[id]/stop/route.ts` | остановка |
| `app/src/app/api/bench/v1/search/route.ts` | поиск |

**Изменить:** `app/src/middleware.ts` — добавить `/api/bench/` в `isPublicApiPath`.

---

### Task 1: Миграция — ключи, журнал, флаг робота

**Files:**
- Create: `supabase/migrations/20260831_0001_bench_api.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- Bench API: внешняя витрина инструментов. Ключи выдаются подрядчикам,
-- каждый привязан к учётке-роботу; задачи по ключу принадлежат роботу,
-- и RLS существующих таблиц сама не отдаёт чужие строки.

alter table public.profiles
  add column if not exists is_api_robot boolean not null default false;

comment on column public.profiles.is_api_robot is
  'Учётка-робот внешнего API. Без пароля, не показывается в списке пользователей админки.';

create table if not exists public.bench_api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique,
  key_last4 text not null,
  robot_user_id uuid not null references public.profiles(id) on delete restrict,
  allowed_tools text[] not null default '{}',
  rpm_limit integer not null default 60,
  daily_jobs_limit integer not null default 50,
  daily_rows_limit integer not null default 200000,
  max_active_jobs integer not null default 3,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.bench_api_keys is
  'Ключи Bench API. Хранится отпечаток (sha256 hex), не сам ключ.';

create table if not exists public.bench_api_requests (
  id bigserial primary key,
  key_id uuid not null references public.bench_api_keys(id) on delete cascade,
  tool text,
  action text not null,
  status_code integer not null,
  rows_returned integer not null default 0,
  duration_ms integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.bench_api_requests is
  'Журнал обращений к Bench API. Тела запросов не пишем — там бывают базы клиентов.';

-- Лимиты считаются оконными запросами по этому индексу.
create index if not exists idx_bench_api_requests_key_created
  on public.bench_api_requests (key_id, created_at desc);

create index if not exists idx_bench_api_requests_key_action_created
  on public.bench_api_requests (key_id, action, created_at desc);

-- Обе таблицы — служебные: к ним ходит только сервисная роль из кода витрины
-- и админки. RLS включаем без политик, то есть обычный пользовательский
-- токен (в том числе токен робота) не видит их вовсе.
alter table public.bench_api_keys enable row level security;
alter table public.bench_api_requests enable row level security;
```

- [ ] **Step 2: Применить миграцию локально**

Run: `npm --prefix app run db:migrate`
Expected: завершается без ошибок; в выводе присутствует `20260831_0001_bench_api`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260831_0001_bench_api.sql
git commit -m "feat(bench-api): таблицы ключей и журнала витрины"
```

---

### Task 2: Ключи — генерация и отпечаток

**Files:**
- Create: `app/src/lib/bench/keys.ts`
- Test: `app/tests/lib/bench/keys.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { BENCH_KEY_PREFIX, generateBenchKey, hashBenchKey, keyLast4 } from '@/lib/bench/keys';

describe('bench keys', () => {
  it('выдаёт ключ с опознаваемым префиксом', () => {
    expect(generateBenchKey().startsWith(`${BENCH_KEY_PREFIX}_`)).toBe(true);
  });

  it('не повторяется', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateBenchKey()));
    expect(keys.size).toBe(200);
  });

  it('отпечаток — 64 hex-символа и стабилен', () => {
    const hash = hashBenchKey('bench_live_example');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBenchKey('bench_live_example')).toBe(hash);
  });

  it('разные ключи дают разные отпечатки', () => {
    expect(hashBenchKey('bench_live_a')).not.toBe(hashBenchKey('bench_live_b'));
  });

  it('отдаёт последние 4 символа для показа в админке', () => {
    expect(keyLast4('bench_live_abcdef12')).toBe('ef12');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- keys.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/keys'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { createHash, randomBytes } from 'node:crypto';

/**
 * Префикс нужен, чтобы утёкший ключ опознавался автопоиском по репозиториям
 * и логам — как это делают GitHub и Stripe со своими токенами.
 */
export const BENCH_KEY_PREFIX = 'bench_live';

export function generateBenchKey(): string {
  return `${BENCH_KEY_PREFIX}_${randomBytes(24).toString('base64url')}`;
}

/** В базе лежит только отпечаток: с доступом к БД ключ не восстановить. */
export function hashBenchKey(key: string): string {
  return createHash('sha256').update(key.trim(), 'utf8').digest('hex');
}

export function keyLast4(key: string): string {
  return key.slice(-4);
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- keys.test.ts`
Expected: PASS, 5 тестов.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/keys.ts app/tests/lib/bench/keys.test.ts
git commit -m "feat(bench-api): генерация и отпечаток ключей"
```

---

### Task 3: Единая форма ошибок

**Files:**
- Create: `app/src/lib/bench/errors.ts`
- Test: `app/tests/lib/bench/errors.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { benchError, BENCH_ERROR_STATUS } from '@/lib/bench/errors';

describe('bench errors', () => {
  it('отдаёт единую форму тела', async () => {
    const res = benchError('invalid_params', 'Параметр search_urls обязателен', { field: 'search_urls' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'invalid_params',
        message: 'Параметр search_urls обязателен',
        details: { field: 'search_urls' },
      },
    });
  });

  it('details по умолчанию null, а не отсутствует', async () => {
    const body = await benchError('not_found', 'Задача не найдена').json();
    expect(body.error.details).toBeNull();
  });

  it('чужая задача и отсутствующая неразличимы по коду ответа', () => {
    expect(BENCH_ERROR_STATUS.not_found).toBe(404);
  });

  it('оба вида превышения лимита дают 429', () => {
    expect(BENCH_ERROR_STATUS.rate_limited).toBe(429);
    expect(BENCH_ERROR_STATUS.quota_exceeded).toBe(429);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- errors.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/errors'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { NextResponse } from 'next/server';

export type BenchErrorCode =
  | 'unauthorized'
  | 'tool_not_allowed'
  | 'invalid_params'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'not_found'
  | 'conflict'
  | 'server_error';

export const BENCH_ERROR_STATUS: Record<BenchErrorCode, number> = {
  unauthorized: 401,
  tool_not_allowed: 403,
  invalid_params: 400,
  rate_limited: 429,
  quota_exceeded: 429,
  // Чужая задача отвечает `not_found`, а не `forbidden`: иначе перебором
  // идентификаторов можно выяснить, какие задачи существуют у других.
  not_found: 404,
  conflict: 409,
  server_error: 500,
};

export function benchError(
  code: BenchErrorCode,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, details: details ?? null } },
    { status: BENCH_ERROR_STATUS[code] },
  );
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- errors.test.ts`
Expected: PASS, 4 теста.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/errors.ts app/tests/lib/bench/errors.test.ts
git commit -m "feat(bench-api): единая форма ошибок"
```

---

### Task 4: Токен робота

Витрине нужен пользовательский токен, чтобы RLS считала её роботом. Подписываем HS256 тем же секретом, которым подписывает GoTrue.

**Files:**
- Create: `app/src/lib/bench/robotToken.ts`
- Test: `app/tests/lib/bench/robotToken.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createHmac } from 'node:crypto';
import { mintRobotToken, ROBOT_TOKEN_TTL_SECONDS } from '@/lib/bench/robotToken';

const ROBOT_ID = '00000000-0000-4000-8000-0000000000aa';

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

describe('robot token', () => {
  const previous = process.env.SUPABASE_JWT_SECRET;
  beforeAll(() => { process.env.SUPABASE_JWT_SECRET = 'test-secret'; });
  afterAll(() => { process.env.SUPABASE_JWT_SECRET = previous; });

  it('кладёт робота в sub и роль authenticated', () => {
    const payload = decodePayload(mintRobotToken(ROBOT_ID, 1_000_000));
    expect(payload.sub).toBe(ROBOT_ID);
    expect(payload.role).toBe('authenticated');
    expect(payload.aud).toBe('authenticated');
  });

  it('живёт недолго', () => {
    const payload = decodePayload(mintRobotToken(ROBOT_ID, 1_000_000));
    expect(payload.exp).toBe(1_000_000 + ROBOT_TOKEN_TTL_SECONDS);
    expect(ROBOT_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(900);
  });

  it('подпись сходится с секретом', () => {
    const token = mintRobotToken(ROBOT_ID, 1_000_000);
    const [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', 'test-secret')
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
  });

  it('без секрета не выпускает токен вовсе', () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(() => mintRobotToken(ROBOT_ID, 1_000_000)).toThrow(/SUPABASE_JWT_SECRET/);
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- robotToken.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/robotToken'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { createHmac } from 'node:crypto';

/**
 * Токен живёт минуты: он выпускается на один запрос витрины и никуда не
 * отдаётся наружу. Короткий срок жизни означает, что даже утёкший из логов
 * токен бесполезен.
 */
export const ROBOT_TOKEN_TTL_SECONDS = 600;

function segment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Токен пользователя Supabase для учётки-робота. Подписывается тем же
 * секретом, что и токены живых людей, поэтому RLS применяется к роботу
 * ровно так же — изоляцию сторожит база, а не наш код.
 */
export function mintRobotToken(
  robotUserId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error('SUPABASE_JWT_SECRET is not configured — Bench API cannot act as a robot');
  }

  const header = segment({ alg: 'HS256', typ: 'JWT' });
  const payload = segment({
    sub: robotUserId,
    aud: 'authenticated',
    role: 'authenticated',
    iss: 'supabase',
    iat: nowSeconds,
    exp: nowSeconds + ROBOT_TOKEN_TTL_SECONDS,
  });
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- robotToken.test.ts`
Expected: PASS, 4 теста.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/robotToken.ts app/tests/lib/bench/robotToken.test.ts
git commit -m "feat(bench-api): токен учётки-робота"
```

---

### Task 5: Клиент, привязанный к владельцу

**Files:**
- Create: `app/src/lib/bench/db.ts`
- Test: `app/tests/lib/bench/db.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

const createAuthedSupabaseClient = jest.fn(() => ({ marker: 'authed' }));

jest.mock('@/lib/supabaseRouteClient', () => ({
  createAuthedSupabaseClient: (token: string) => createAuthedSupabaseClient(token),
}));

import { createBenchDb } from '@/lib/bench/db';

const ROBOT_ID = '00000000-0000-4000-8000-0000000000aa';

describe('bench db', () => {
  const previous = process.env.SUPABASE_JWT_SECRET;
  beforeAll(() => { process.env.SUPABASE_JWT_SECRET = 'test-secret'; });
  afterAll(() => { process.env.SUPABASE_JWT_SECRET = previous; });
  beforeEach(() => createAuthedSupabaseClient.mockClear());

  it('строит клиент по токену робота, а не сервисным ключом', () => {
    createBenchDb(ROBOT_ID);
    const token = createAuthedSupabaseClient.mock.calls[0][0] as string;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe(ROBOT_ID);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- db.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/db'`.

- [ ] **Step 3: Написать реализацию**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { mintRobotToken } from './robotToken';

/**
 * ЕДИНСТВЕННЫЙ способ, которым витрина ходит в данные задач.
 *
 * Клиент привязан к учётке-роботу, поэтому RLS сама отсекает чужие строки.
 * Сервисный ключ (`supabaseAdmin`) обходит RLS и в роутах витрины запрещён —
 * это проверяется тестом в Task 18.
 */
export function createBenchDb(robotUserId: string): SupabaseClient {
  return createAuthedSupabaseClient(mintRobotToken(robotUserId));
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- db.test.ts`
Expected: PASS, 1 тест.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/db.ts app/tests/lib/bench/db.test.ts
git commit -m "feat(bench-api): клиент от имени учётки-робота"
```

---

### Task 6: Типы контракта и адаптеров

Чистый файл типов — без тестов, его проверяет `typecheck:strict` и использование в следующих задачах.

**Files:**
- Create: `app/src/lib/bench/types.ts`

- [ ] **Step 1: Написать типы**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodType } from 'zod';

/** Единый словарь статусов наружу. Внутри инструменты называют их вразнобой. */
export type BenchStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export type JobRow = Record<string, unknown>;

/** Что витрина отдаёт про задачу — одинаково для всех инструментов. */
export interface BenchJobView {
  id: string;
  tool: string;
  status: BenchStatus;
  progress: { done: number; total: number | null };
  rows_found: number;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
}

export type BenchStopSupport =
  | { supported: true; stoppedStatus: string }
  | { supported: false; reason: string };

export interface BenchJobTool {
  id: string;
  kind: 'job';
  title: string;
  /** Таблица задач, куда адаптер пишет строку. */
  table: string;
  paramsSchema: ZodType;
  /** Строка задачи ровно в том виде, в каком её создаёт сам портал. */
  buildRow(params: never, ownerId: string): JobRow;
  mapStatus(row: JobRow): BenchStatus;
  progress(row: JobRow): { done: number; total: number | null };
  rowsFound(row: JobRow): number;
  errorOf(row: JobRow): string | null;
  finishedAt(row: JobRow): string | null;
  results: { table: string; jobColumn: string; orderColumn: string };
  stop: BenchStopSupport;
}

export interface BenchSearchPage {
  rows: unknown[];
  cursor: string | null;
  has_more: boolean;
}

export interface BenchSearchTool {
  id: string;
  kind: 'search';
  title: string;
  filtersSchema: ZodType;
  run(args: {
    db: SupabaseClient;
    filters: never;
    limit: number;
    cursor: string | null;
  }): Promise<BenchSearchPage>;
}

// Метода `count` здесь намеренно нет. Базы поиска большие (в pdl_companies
// 13 млн строк), и `select(count: 'exact')` по ним идёт секундами — портал
// поэтому считает не точно, а оценкой планировщика в отдельной ручке.
// Точный подсчёт наружу не обещаем; `POST /search/count` появится в
// следующем плане вместе с механизмом оценки.

export type BenchTool = BenchJobTool | BenchSearchTool;
```

- [ ] **Step 2: Проверить типы**

Run: `npm --prefix app run typecheck:strict`
Expected: завершается без ошибок.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/bench/types.ts
git commit -m "feat(bench-api): типы контракта и адаптеров"
```

---

### Task 7: Эталонный задачный адаптер — Яндекс.Карты

**Files:**
- Create: `app/src/lib/bench/tools/yandexmaps.ts`
- Test: `app/tests/lib/bench/toolYandexMaps.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { yandexMapsTool } from '@/lib/bench/tools/yandexmaps';

const OWNER = '00000000-0000-4000-8000-0000000000aa';

describe('адаптер yandexmaps', () => {
  it('принимает корректные параметры', () => {
    const parsed = yandexMapsTool.paramsSchema.safeParse({
      search_urls: ['https://yandex.ru/maps/?text=кофейни'],
      max_results: 500,
    });
    expect(parsed.success).toBe(true);
  });

  it('требует хотя бы одну ссылку', () => {
    expect(yandexMapsTool.paramsSchema.safeParse({ search_urls: [] }).success).toBe(false);
  });

  it('не пропускает лишние поля', () => {
    const parsed = yandexMapsTool.paramsSchema.safeParse({
      search_urls: ['https://yandex.ru/maps/?text=кофейни'],
      user_id: OWNER,
    });
    expect(parsed.success).toBe(false);
  });

  it('строит строку задачи с владельцем и статусом pending', () => {
    const params = yandexMapsTool.paramsSchema.parse({
      search_urls: ['https://yandex.ru/maps/?text=кофейни'],
      max_results: 500,
    });
    const row = yandexMapsTool.buildRow(params as never, OWNER);
    expect(row.user_id).toBe(OWNER);
    expect(row.status).toBe('pending');
    expect(row.config).toEqual({
      search_urls: ['https://yandex.ru/maps/?text=кофейни'],
      catalog_filters: null,
      max_results: 500,
      headless: true,
    });
  });

  it('переводит внутренние статусы в общий словарь', () => {
    expect(yandexMapsTool.mapStatus({ status: 'pending' })).toBe('queued');
    expect(yandexMapsTool.mapStatus({ status: 'running' })).toBe('running');
    expect(yandexMapsTool.mapStatus({ status: 'completed' })).toBe('done');
    expect(yandexMapsTool.mapStatus({ status: 'failed' })).toBe('failed');
  });

  it('честно сообщает, что остановки у него нет', () => {
    expect(yandexMapsTool.stop.supported).toBe(false);
  });

  it('отдаёт прогресс и число найденных строк', () => {
    const row = { processed_organizations: 118, total_organizations: 500 };
    expect(yandexMapsTool.progress(row)).toEqual({ done: 118, total: 500 });
    expect(yandexMapsTool.rowsFound(row)).toBe(118);
  });

  it('total = null, пока воркер не знает объёма', () => {
    expect(yandexMapsTool.progress({ total_organizations: 0 }).total).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- toolYandexMaps.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/tools/yandexmaps'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { z } from 'zod';
import type { BenchJobTool, JobRow } from '../types';

const paramsSchema = z
  .object({
    search_urls: z.array(z.string().url()).min(1).max(50),
    max_results: z.number().int().min(1).max(5000).default(1000),
  })
  .strict();

type Params = z.infer<typeof paramsSchema>;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const yandexMapsTool: BenchJobTool = {
  id: 'yandexmaps',
  kind: 'job',
  title: 'Яндекс.Карты',
  table: 'yandex_maps_jobs',
  paramsSchema,

  // Строка ровно та же, что кладёт портал (см. app/src/app/api/parsers/
  // yandexmaps/route.ts). Воркер не отличает задачу витрины от задачи человека.
  buildRow(params, ownerId) {
    const p = params as unknown as Params;
    return {
      user_id: ownerId,
      status: 'pending',
      config: {
        search_urls: p.search_urls,
        catalog_filters: null,
        max_results: p.max_results,
        headless: true,
      },
      progress_stage: 'pending',
    };
  },

  mapStatus(row: JobRow) {
    switch (row.status) {
      case 'pending':
        return 'queued';
      case 'running':
        return 'running';
      case 'completed':
        return 'done';
      default:
        return 'failed';
    }
  },

  // total=0 означает «воркер ещё не знает объёма», а не «нечего делать».
  progress(row: JobRow) {
    const total = num(row.total_organizations);
    return { done: num(row.processed_organizations), total: total || null };
  },

  rowsFound(row: JobRow) {
    return num(row.processed_organizations);
  },

  errorOf(row: JobRow) {
    return text(row.error_message);
  },

  finishedAt(row: JobRow) {
    return text(row.completed_at);
  },

  results: {
    table: 'yandex_maps_organizations',
    jobColumn: 'job_id',
    orderColumn: 'created_at',
  },

  // У таблицы ограничение check (status in ('pending','running','completed',
  // 'failed')) — статуса «остановлена» нет, и ручки остановки у инструмента
  // тоже нет. Добавлять их — менять воркер работающего парсера, что вне
  // объёма витрины.
  stop: {
    supported: false,
    reason: 'Яндекс.Карты не поддерживают остановку задачи — дождитесь завершения',
  },
};
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- toolYandexMaps.test.ts`
Expected: PASS, 8 тестов.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/tools/yandexmaps.ts app/tests/lib/bench/toolYandexMaps.test.ts
git commit -m "feat(bench-api): адаптер Яндекс.Карт"
```

---

### Task 8: Реестр инструментов

**Files:**
- Create: `app/src/lib/bench/registry.ts`
- Test: `app/tests/lib/bench/registry.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { getBenchTool, listBenchTools, describeBenchTool } from '@/lib/bench/registry';

describe('реестр инструментов', () => {
  it('находит инструмент по ключу', () => {
    expect(getBenchTool('yandexmaps')?.id).toBe('yandexmaps');
  });

  it('на неизвестный ключ отдаёт null, а не бросает', () => {
    expect(getBenchTool('нет-такого')).toBeNull();
  });

  it('показывает только разрешённые ключу инструменты', () => {
    const ids = listBenchTools(['yandexmaps']).map((t) => t.id);
    expect(ids).toEqual(['yandexmaps']);
  });

  it('пустой список разрешённых означает «ничего», а не «всё»', () => {
    expect(listBenchTools([])).toEqual([]);
  });

  it('описание инструмента несёт схему параметров и поддержку остановки', () => {
    const described = describeBenchTool(getBenchTool('yandexmaps')!);
    expect(described.id).toBe('yandexmaps');
    expect(described.kind).toBe('job');
    expect(described.stop_supported).toBe(false);
    expect(described.params).toHaveProperty('properties.search_urls');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- registry.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/registry'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { z } from 'zod';
import { yandexMapsTool } from './tools/yandexmaps';
import type { BenchTool } from './types';

/**
 * Единственное место, где перечислены инструменты витрины. Роуты не знают о
 * конкретных инструментах ничего — только про этот реестр.
 */
const TOOLS: BenchTool[] = [yandexMapsTool];

const BY_ID = new Map<string, BenchTool>(TOOLS.map((tool) => [tool.id, tool]));

export function getBenchTool(id: string): BenchTool | null {
  return BY_ID.get(id) ?? null;
}

/** Пустой список разрешённых — это «ничего не разрешено», не «всё». */
export function listBenchTools(allowedIds: readonly string[]): BenchTool[] {
  const allowed = new Set(allowedIds);
  return TOOLS.filter((tool) => allowed.has(tool.id));
}

export interface BenchToolDescription {
  id: string;
  kind: 'job' | 'search';
  title: string;
  stop_supported: boolean;
  stop_reason: string | null;
  params: unknown;
}

/**
 * Машинное описание для `GET /tools`. Схема параметров берётся из той же
 * zod-схемы, по которой идёт проверка входа, — поэтому каталог не может
 * разойтись с реальным поведением.
 */
export function describeBenchTool(tool: BenchTool): BenchToolDescription {
  const schema = tool.kind === 'job' ? tool.paramsSchema : tool.filtersSchema;
  return {
    id: tool.id,
    kind: tool.kind,
    title: tool.title,
    stop_supported: tool.kind === 'job' ? tool.stop.supported : false,
    stop_reason: tool.kind === 'job' && !tool.stop.supported ? tool.stop.reason : null,
    params: z.toJSONSchema(schema),
  };
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- registry.test.ts`
Expected: PASS, 5 тестов.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/registry.ts app/tests/lib/bench/registry.test.ts
git commit -m "feat(bench-api): реестр инструментов и самоописание"
```

---

### Task 9: Эталонный поисковый адаптер — наша база компаний

Поиск отвечает сразу, очереди нет. Курсор — идентификатор последней отданной строки: смещение на растущей таблице теряет и дублирует строки.

**Files:**
- Create: `app/src/lib/bench/tools/companyBase.ts`
- Test: `app/tests/lib/bench/toolCompanyBase.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { companyBaseTool } from '@/lib/bench/tools/companyBase';

function db(rows: Array<Record<string, unknown>>) {
  return createMockSupabase({ tables: { pdl_companies: rows } }) as never;
}

const ROWS = [
  { id: 'c1', name: 'Alpha', country: 'russia', industry: 'software', size: '11-50' },
  { id: 'c2', name: 'Beta', country: 'russia', industry: 'software', size: '51-200' },
  { id: 'c3', name: 'Gamma', country: 'germany', industry: 'retail', size: '11-50' },
];

describe('адаптер company-base', () => {
  it('принимает фильтры портала', () => {
    const parsed = companyBaseTool.filtersSchema.safeParse({
      country: ['russia'], industry: ['software'], size: ['11-50'], name: 'Alp',
    });
    expect(parsed.success).toBe(true);
  });

  it('не пропускает лишние фильтры', () => {
    expect(companyBaseTool.filtersSchema.safeParse({ drop_table: 'x' }).success).toBe(false);
  });

  it('отдаёт страницу и курсор последней строки', async () => {
    const page = await companyBaseTool.run({
      db: db(ROWS), filters: { country: ['russia'] } as never, limit: 2, cursor: null,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.cursor).toBe('c2');
    expect(page.has_more).toBe(true);
  });

  it('на последней странице курсор пуст и has_more ложно', async () => {
    const page = await companyBaseTool.run({
      db: db(ROWS), filters: {} as never, limit: 10, cursor: null,
    });
    expect(page.has_more).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it('экранирует подстановочные знаки в поиске по имени', () => {
    expect(companyBaseTool.escapeLike('100%_рост')).toBe('100рост');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- toolCompanyBase.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/tools/companyBase'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { z } from 'zod';
import type { BenchSearchPage, BenchSearchTool } from '../types';

const TABLE = 'pdl_companies';
const SELECT = 'id, name, country, industry, size, website, linkedin_url';

// Фильтры повторяют те, что портал предлагает в UI поиска по базе компаний
// (см. app/src/app/api/company-base/search/route.ts): списковые country /
// industry / size и подстрока по имени.
const filtersSchema = z
  .object({
    country: z.array(z.string().min(1).max(100)).max(50).optional(),
    industry: z.array(z.string().min(1).max(100)).max(50).optional(),
    size: z.array(z.string().min(1).max(50)).max(20).optional(),
    name: z.string().min(2).max(200).optional(),
  })
  .strict();

type Filters = z.infer<typeof filtersSchema>;

interface FilterableQuery {
  in: (column: string, values: string[]) => FilterableQuery;
  ilike: (column: string, pattern: string) => FilterableQuery;
}

/**
 * `%` и `_` в пользовательской строке — подстановочные знаки LIKE. Без
 * вырезания запрос `%` означает «все 13 млн строк», то есть один символ
 * превращается в выгрузку всей базы. Портал экранирует их так же.
 */
function escapeLike(value: string): string {
  return value.replace(/[%_]/g, '');
}

function applyFilters<T extends FilterableQuery>(query: T, filters: Filters): T {
  let q = query;
  if (filters.country?.length) q = q.in('country', filters.country) as T;
  if (filters.industry?.length) q = q.in('industry', filters.industry) as T;
  if (filters.size?.length) q = q.in('size', filters.size) as T;
  if (filters.name) q = q.ilike('name', `%${escapeLike(filters.name)}%`) as T;
  return q;
}

export const companyBaseTool: BenchSearchTool & { escapeLike: typeof escapeLike } = {
  id: 'company-base',
  kind: 'search',
  title: 'Наша база компаний',
  filtersSchema,
  escapeLike,

  // Курсор — id последней отданной строки, а не смещение: в таблице 13 млн
  // строк, и `offset` на глубоких страницах заставляет Postgres прочитать и
  // выбросить всё до смещения, а на растущей таблице ещё и теряет строки.
  async run({ db, filters, limit, cursor }): Promise<BenchSearchPage> {
    let query = db.from(TABLE).select(SELECT).order('id', { ascending: true }).limit(limit);
    query = applyFilters(query as never, filters as unknown as Filters) as never;
    if (cursor) query = query.gt('id', cursor);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const hasMore = rows.length === limit;
    const last = rows[rows.length - 1];
    return {
      rows,
      cursor: hasMore && last ? String(last.id) : null,
      has_more: hasMore,
    };
  },
};
```

- [ ] **Step 4: Внести адаптер в реестр**

В `app/src/lib/bench/registry.ts` добавить импорт и расширить список:

```ts
import { companyBaseTool } from './tools/companyBase';
```

```ts
const TOOLS: BenchTool[] = [yandexMapsTool, companyBaseTool];
```

- [ ] **Step 5: Дописать проверку в тест реестра**

В конец `describe` в `app/tests/lib/bench/registry.test.ts`:

```ts
  it('знает про поисковый источник', () => {
    const tool = getBenchTool('company-base');
    expect(tool?.kind).toBe('search');
  });

  it('описывает поисковый источник без остановки', () => {
    const described = describeBenchTool(getBenchTool('company-base')!);
    expect(described.kind).toBe('search');
    expect(described.stop_supported).toBe(false);
    expect(described.params).toHaveProperty('properties.country');
  });
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `npm --prefix app test -- toolCompanyBase.test.ts registry.test.ts`
Expected: PASS — оба файла зелёные, в реестре 7 тестов.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/bench/tools/companyBase.ts app/src/lib/bench/registry.ts app/tests/lib/bench/toolCompanyBase.test.ts app/tests/lib/bench/registry.test.ts
git commit -m "feat(bench-api): поисковый адаптер базы компаний"
```

---

### Task 10: Проверка ключа

**Files:**
- Create: `app/src/lib/bench/auth.ts`
- Test: `app/tests/lib/bench/auth.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { hashBenchKey } from '@/lib/bench/keys';

const ROBOT_ID = '00000000-0000-4000-8000-0000000000aa';
const GOOD_KEY = 'bench_live_good';
const REVOKED_KEY = 'bench_live_revoked';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() { return mockDb; },
}));

jest.mock('@/lib/bench/db', () => ({
  createBenchDb: jest.fn((ownerId: string) => ({ ownerId })),
}));

import { authenticateBench } from '@/lib/bench/auth';

function request(header: string | null): never {
  return { headers: { get: (n: string) => (n.toLowerCase() === 'authorization' ? header : null) } } as never;
}

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      bench_api_keys: [
        {
          id: 'k1', name: 'Дима', key_hash: hashBenchKey(GOOD_KEY), key_last4: 'good',
          robot_user_id: ROBOT_ID, allowed_tools: ['yandexmaps'], revoked_at: null,
          rpm_limit: 60, daily_jobs_limit: 50, daily_rows_limit: 1000, max_active_jobs: 3,
        },
        {
          id: 'k2', name: 'Старый', key_hash: hashBenchKey(REVOKED_KEY), key_last4: 'oked',
          robot_user_id: ROBOT_ID, allowed_tools: ['yandexmaps'],
          revoked_at: '2026-08-01T00:00:00Z',
          rpm_limit: 60, daily_jobs_limit: 50, daily_rows_limit: 1000, max_active_jobs: 3,
        },
      ],
    },
  });
});

describe('authenticateBench', () => {
  it('пускает по действующему ключу', async () => {
    const result = await authenticateBench(request(`Bearer ${GOOD_KEY}`));
    expect('key' in result && result.key.id).toBe('k1');
  });

  it('без заголовка отвечает unauthorized', async () => {
    const result = await authenticateBench(request(null));
    expect('status' in result && result.status).toBe(401);
  });

  it('неизвестный ключ — unauthorized', async () => {
    const result = await authenticateBench(request('Bearer bench_live_nope'));
    expect('status' in result && result.status).toBe(401);
  });

  it('отозванный ключ перестаёт работать сразу', async () => {
    const result = await authenticateBench(request(`Bearer ${REVOKED_KEY}`));
    expect('status' in result && result.status).toBe(401);
  });

  it('ищет ключ по отпечатку, а не по самому ключу', async () => {
    await authenticateBench(request(`Bearer ${GOOD_KEY}`));
    const filters = JSON.stringify(mockDb.mutations ?? []);
    expect(filters).not.toContain(GOOD_KEY);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- auth.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/auth'`.

- [ ] **Step 3: Написать реализацию**

```ts
import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { safeEqual } from '@/lib/crypto/safeEqual';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getBearerToken } from '@/lib/supabaseRouteClient';
import { createBenchDb } from './db';
import { benchError } from './errors';
import { hashBenchKey } from './keys';

export interface BenchKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_last4: string;
  robot_user_id: string;
  allowed_tools: string[];
  rpm_limit: number;
  daily_jobs_limit: number;
  daily_rows_limit: number;
  max_active_jobs: number;
  revoked_at: string | null;
}

export interface BenchAuth {
  key: BenchKeyRow;
  db: SupabaseClient;
}

/**
 * Проверка идёт в базу на КАЖДОМ запросе, без кэша. «Отозвать за минуту»
 * должно означать, что следующий же запрос получает отказ; кэш даже на
 * минуту превращает отзыв в обещание ровно тогда, когда он нужен всерьёз —
 * при утечке ключа.
 */
export async function authenticateBench(req: NextRequest): Promise<BenchAuth | NextResponse> {
  const raw =
    getBearerToken(req.headers.get('authorization')) ?? req.headers.get('x-api-key');
  if (!raw) {
    return benchError('unauthorized', 'Нужен ключ: заголовок Authorization: Bearer bench_live_…');
  }
  if (!supabaseAdmin) {
    return benchError('server_error', 'Bench API не настроен');
  }

  const hash = hashBenchKey(raw);
  const { data } = await supabaseAdmin
    .from('bench_api_keys')
    .select(
      'id, name, key_hash, key_last4, robot_user_id, allowed_tools, rpm_limit, daily_jobs_limit, daily_rows_limit, max_active_jobs, revoked_at',
    )
    .eq('key_hash', hash)
    .maybeSingle();

  const key = data as BenchKeyRow | null;
  if (!key || !safeEqual(key.key_hash, hash)) {
    return benchError('unauthorized', 'Ключ не найден');
  }
  if (key.revoked_at) {
    return benchError('unauthorized', 'Ключ отозван');
  }

  return { key, db: createBenchDb(key.robot_user_id) };
}

export function isBenchAuth(value: BenchAuth | NextResponse): value is BenchAuth {
  return 'key' in value;
}

/** Инструмент, которого нет в списке ключа, для него не существует. */
export function assertToolAllowed(key: BenchKeyRow, toolId: string): NextResponse | null {
  if (key.allowed_tools.includes(toolId)) return null;
  return benchError('tool_not_allowed', `Инструмент «${toolId}» не открыт этому ключу`);
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- auth.test.ts`
Expected: PASS, 5 тестов.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/auth.ts app/tests/lib/bench/auth.test.ts
git commit -m "feat(bench-api): проверка ключа и список инструментов"
```

---

### Task 11: Журнал обращений

**Files:**
- Create: `app/src/lib/bench/journal.ts`
- Test: `app/tests/lib/bench/journal.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() { return mockDb; },
}));

import { logBenchRequest } from '@/lib/bench/journal';

beforeEach(() => {
  mockDb = createMockSupabase({ tables: { bench_api_requests: [], bench_api_keys: [{ id: 'k1' }] } });
});

describe('журнал', () => {
  it('пишет обращение', async () => {
    await logBenchRequest({
      keyId: 'k1', tool: 'yandexmaps', action: 'create_job',
      statusCode: 200, rowsReturned: 0, durationMs: 42,
    });
    const inserts = mockDb.mutations.filter((m) => m.kind === 'insert' && m.table === 'bench_api_requests');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].rows[0]).toMatchObject({ key_id: 'k1', action: 'create_job', status_code: 200 });
  });

  it('не пишет тела запросов — в строке журнала нет полей с данными', async () => {
    await logBenchRequest({
      keyId: 'k1', tool: 'yandexmaps', action: 'create_job',
      statusCode: 200, rowsReturned: 0, durationMs: 42,
    });
    const row = mockDb.mutations.find((m) => m.kind === 'insert')!.rows[0];
    expect(Object.keys(row).sort()).toEqual(
      ['action', 'duration_ms', 'key_id', 'rows_returned', 'status_code', 'tool'],
    );
  });

  it('падение журнала не роняет запрос', async () => {
    mockDb = createMockSupabase({});
    await expect(
      logBenchRequest({ keyId: 'k1', tool: null, action: 'list_jobs', statusCode: 200, rowsReturned: 0, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- journal.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/journal'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface BenchRequestLog {
  keyId: string;
  tool: string | null;
  action: string;
  statusCode: number;
  rowsReturned: number;
  durationMs: number;
}

/**
 * Пишем только метаданные: тела запросов содержат базы клиентов, и хранить
 * их в журнале означало бы копить чужие персональные данные без нужды.
 *
 * Журнал не должен ронять запрос: если запись не удалась, обращение всё
 * равно обслужено — молча проглатываем.
 */
export async function logBenchRequest(entry: BenchRequestLog): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('bench_api_requests').insert({
      key_id: entry.keyId,
      tool: entry.tool,
      action: entry.action,
      status_code: entry.statusCode,
      rows_returned: entry.rowsReturned,
      duration_ms: entry.durationMs,
    });
    await supabaseAdmin
      .from('bench_api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', entry.keyId);
  } catch {
    // намеренно молча
  }
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- journal.test.ts`
Expected: PASS, 3 теста.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/journal.ts app/tests/lib/bench/journal.test.ts
git commit -m "feat(bench-api): журнал обращений"
```

---

### Task 12: Лимиты

Все три лимита считаются по журналу — так они одинаковы для всех инструментов и не требуют лезть в 15 разных таблиц.

**Files:**
- Create: `app/src/lib/bench/limits.ts`
- Test: `app/tests/lib/bench/limits.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() { return mockDb; },
}));

import { checkBenchLimits } from '@/lib/bench/limits';

const KEY = {
  id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234',
  robot_user_id: 'r1', allowed_tools: ['yandexmaps'],
  rpm_limit: 2, daily_jobs_limit: 2, daily_rows_limit: 100, max_active_jobs: 3,
  revoked_at: null,
};

function seed(requests: Array<Record<string, unknown>>) {
  mockDb = createMockSupabase({ tables: { bench_api_requests: requests } });
}

const now = new Date('2026-08-31T12:00:00Z');
const recent = new Date('2026-08-31T11:59:30Z').toISOString();

describe('лимиты', () => {
  it('пропускает, пока норма не выбрана', async () => {
    seed([]);
    expect(await checkBenchLimits(KEY, 'read', now)).toBeNull();
  });

  it('режет по запросам в минуту', async () => {
    seed([
      { key_id: 'k1', action: 'list_jobs', status_code: 200, rows_returned: 0, created_at: recent },
      { key_id: 'k1', action: 'list_jobs', status_code: 200, rows_returned: 0, created_at: recent },
    ]);
    const res = await checkBenchLimits(KEY, 'read', now);
    expect(res?.status).toBe(429);
    await expect(res!.json()).resolves.toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('режет по задачам в сутки', async () => {
    seed([
      { key_id: 'k1', action: 'create_job', status_code: 200, rows_returned: 0, created_at: '2026-08-31T01:00:00Z' },
      { key_id: 'k1', action: 'create_job', status_code: 200, rows_returned: 0, created_at: '2026-08-31T02:00:00Z' },
    ]);
    const res = await checkBenchLimits(KEY, 'create_job', now);
    await expect(res!.json()).resolves.toMatchObject({ error: { code: 'quota_exceeded' } });
  });

  it('неудачные попытки не съедают суточную норму задач', async () => {
    seed([
      { key_id: 'k1', action: 'create_job', status_code: 400, rows_returned: 0, created_at: '2026-08-31T01:00:00Z' },
      { key_id: 'k1', action: 'create_job', status_code: 400, rows_returned: 0, created_at: '2026-08-31T02:00:00Z' },
    ]);
    expect(await checkBenchLimits(KEY, 'create_job', now)).toBeNull();
  });

  it('режет по строкам в сутки', async () => {
    seed([
      { key_id: 'k1', action: 'results', status_code: 200, rows_returned: 100, created_at: '2026-08-31T03:00:00Z' },
    ]);
    const res = await checkBenchLimits(KEY, 'results', now);
    await expect(res!.json()).resolves.toMatchObject({ error: { code: 'quota_exceeded' } });
  });

  it('в отказе сказано, когда можно снова', async () => {
    seed([
      { key_id: 'k1', action: 'list_jobs', status_code: 200, rows_returned: 0, created_at: recent },
      { key_id: 'k1', action: 'list_jobs', status_code: 200, rows_returned: 0, created_at: recent },
    ]);
    const res = await checkBenchLimits(KEY, 'read', now);
    expect(res!.headers.get('Retry-After')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- limits.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/limits'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { BenchKeyRow } from './auth';
import { benchError } from './errors';

export type BenchAction = 'read' | 'create_job' | 'results' | 'stop' | 'search';

/** Начало текущих МСК-суток в UTC: сутки считаем по московскому дню. */
function mskDayStartUtc(now: Date): string {
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const start = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  return new Date(start - 3 * 60 * 60 * 1000).toISOString();
}

function retryAfter(seconds: number, response: NextResponse): NextResponse {
  response.headers.set('Retry-After', String(seconds));
  return response;
}

/**
 * Все три потолка считаются по журналу обращений — одинаково для любого
 * инструмента, без похода в 15 разных таблиц задач.
 */
export async function checkBenchLimits(
  key: BenchKeyRow,
  action: BenchAction,
  now: Date = new Date(),
): Promise<NextResponse | null> {
  if (!supabaseAdmin) return null;

  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const { count: lastMinute } = await supabaseAdmin
    .from('bench_api_requests')
    .select('id', { count: 'exact', head: true })
    .eq('key_id', key.id)
    .gte('created_at', minuteAgo);

  if ((lastMinute ?? 0) >= key.rpm_limit) {
    return retryAfter(
      60,
      benchError('rate_limited', `Не больше ${key.rpm_limit} запросов в минуту`, {
        limit: key.rpm_limit,
        retry_after_seconds: 60,
      }),
    );
  }

  const dayStart = mskDayStartUtc(now);

  if (action === 'create_job') {
    // Считаем только успешные постановки: отказ по кривым параметрам не
    // должен съедать суточную норму — иначе отладка скрипта её выжигает.
    const { count: createdToday } = await supabaseAdmin
      .from('bench_api_requests')
      .select('id', { count: 'exact', head: true })
      .eq('key_id', key.id)
      .eq('action', 'create_job')
      .lt('status_code', 300)
      .gte('created_at', dayStart);

    if ((createdToday ?? 0) >= key.daily_jobs_limit) {
      return benchError('quota_exceeded', `Исчерпана суточная норма: ${key.daily_jobs_limit} задач`, {
        limit: key.daily_jobs_limit,
        resets_at: dayStart,
      });
    }
  }

  if (action === 'results' || action === 'search') {
    const { data } = await supabaseAdmin
      .from('bench_api_requests')
      .select('rows_returned')
      .eq('key_id', key.id)
      .gte('created_at', dayStart);

    const rowsToday = (data ?? []).reduce(
      (sum: number, row: { rows_returned?: number }) => sum + Number(row.rows_returned ?? 0),
      0,
    );
    if (rowsToday >= key.daily_rows_limit) {
      return benchError('quota_exceeded', `Исчерпана суточная норма: ${key.daily_rows_limit} строк`, {
        limit: key.daily_rows_limit,
        resets_at: dayStart,
      });
    }
  }

  return null;
}

/**
 * Потолок одновременных задач. Общая параллельность воркеров одна на всех,
 * поэтому робот не должен занимать очередь целиком и отодвигать живых людей.
 * Считается по таблице самого инструмента через клиент робота — то есть
 * видит только его собственные задачи.
 */
export async function checkActiveJobs(
  db: { from: (t: string) => never },
  key: BenchKeyRow,
  table: string,
  activeStatuses: string[],
): Promise<NextResponse | null> {
  const query = db.from(table) as unknown as {
    select: (c: string, o: object) => { in: (c: string, v: string[]) => Promise<{ count: number | null }> };
  };
  const { count } = await query
    .select('id', { count: 'exact', head: true })
    .in('status', activeStatuses);

  if ((count ?? 0) >= key.max_active_jobs) {
    return benchError('conflict', `Не больше ${key.max_active_jobs} незавершённых задач одновременно`, {
      limit: key.max_active_jobs,
    });
  }
  return null;
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- limits.test.ts`
Expected: PASS, 6 тестов.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/limits.ts app/tests/lib/bench/limits.test.ts
git commit -m "feat(bench-api): лимиты по запросам, задачам и строкам"
```

---

### Task 13: Пропустить `/api/bench/` через middleware

**Files:**
- Modify: `app/src/middleware.ts` (функция `isPublicApiPath`)
- Test: `app/tests/lib/bench/middlewarePath.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('middleware пропускает витрину', () => {
  const source = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8');

  it('в isPublicApiPath есть /api/bench/', () => {
    const fn = source.slice(source.indexOf('function isPublicApiPath'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain("'/api/bench/'");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- middlewarePath.test.ts`
Expected: FAIL — строки нет.

- [ ] **Step 3: Внести правку**

В `app/src/middleware.ts`, в функции `isPublicApiPath`, добавить строку в возвращаемое выражение — сразу после `p.startsWith('/api/partner/')`:

```ts
    p.startsWith('/api/partner/') || // external pull-API, auth'd by PARTNER_API_KEY
    p.startsWith('/api/bench/') || // внешняя витрина инструментов, auth по ключу bench_live_*
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- middlewarePath.test.ts`
Expected: PASS, 1 тест.

- [ ] **Step 5: Commit**

```bash
git add app/src/middleware.ts app/tests/lib/bench/middlewarePath.test.ts
git commit -m "feat(bench-api): пропустить витрину через пропускной пункт"
```

---

### Task 14: Роут каталога `GET /tools`

**Files:**
- Create: `app/src/app/api/bench/v1/tools/route.ts`
- Test: `app/tests/api/benchTools.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import type { NextRequest } from 'next/server';

const KEY = {
  id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234', robot_user_id: 'r1',
  allowed_tools: ['yandexmaps'], rpm_limit: 60, daily_jobs_limit: 50,
  daily_rows_limit: 1000, max_active_jobs: 3, revoked_at: null,
};

let authResult: unknown = { key: KEY, db: {} };

jest.mock('@/lib/bench/auth', () => ({
  authenticateBench: jest.fn(async () => authResult),
  isBenchAuth: (v: unknown) => typeof v === 'object' && v !== null && 'key' in v,
  assertToolAllowed: jest.requireActual('@/lib/bench/auth').assertToolAllowed,
}));
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { GET } from '@/app/api/bench/v1/tools/route';

const req = { headers: { get: () => null } } as unknown as NextRequest;

describe('GET /api/bench/v1/tools', () => {
  it('показывает только разрешённые ключу инструменты', async () => {
    const body = await (await GET(req)).json();
    expect(body.tools.map((t: { id: string }) => t.id)).toEqual(['yandexmaps']);
  });

  it('сообщает про поддержку остановки', async () => {
    const body = await (await GET(req)).json();
    expect(body.tools[0].stop_supported).toBe(false);
    expect(body.tools[0].stop_reason).toContain('остановку');
  });

  it('несёт машинную схему параметров', async () => {
    const body = await (await GET(req)).json();
    expect(body.tools[0].params.properties).toHaveProperty('search_urls');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- benchTools.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/bench/v1/tools/route'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { describeBenchTool, listBenchTools } from '@/lib/bench/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Каталог доступного. Собирается из тех же zod-схем, по которым идёт проверка
 * входа, поэтому не может разойтись с реальным поведением витрины.
 */
export async function GET(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const limited = await checkBenchLimits(auth.key, 'read');
  if (limited) {
    await logBenchRequest({
      keyId: auth.key.id, tool: null, action: 'tools',
      statusCode: limited.status, rowsReturned: 0, durationMs: Date.now() - started,
    });
    return limited;
  }

  const tools = listBenchTools(auth.key.allowed_tools).map(describeBenchTool);

  await logBenchRequest({
    keyId: auth.key.id, tool: null, action: 'tools',
    statusCode: 200, rowsReturned: 0, durationMs: Date.now() - started,
  });

  return NextResponse.json({ tools });
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- benchTools.test.ts`
Expected: PASS, 3 теста.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/api/bench/v1/tools/route.ts app/tests/api/benchTools.test.ts
git commit -m "feat(bench-api): каталог инструментов"
```

---

### Task 15: Общее представление задачи

Роуты задач возвращают одинаковую форму — выносим её в одно место, чтобы три роута не расходились.

**Files:**
- Create: `app/src/lib/bench/jobView.ts`
- Test: `app/tests/lib/bench/jobView.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { toBenchJobView } from '@/lib/bench/jobView';
import { yandexMapsTool } from '@/lib/bench/tools/yandexmaps';

describe('представление задачи', () => {
  it('приводит строку таблицы к общей форме', () => {
    const view = toBenchJobView(yandexMapsTool, {
      id: 'j1', status: 'running', processed_organizations: 118,
      total_organizations: 500, error_message: null,
      created_at: '2026-08-31T10:00:00Z', completed_at: null,
    });
    expect(view).toEqual({
      id: 'j1',
      tool: 'yandexmaps',
      status: 'running',
      progress: { done: 118, total: 500 },
      rows_found: 118,
      error: null,
      created_at: '2026-08-31T10:00:00Z',
      finished_at: null,
    });
  });

  it('не протаскивает наружу внутренние поля таблицы', () => {
    const view = toBenchJobView(yandexMapsTool, {
      id: 'j1', status: 'pending', user_id: 'secret-owner',
      proxy_credentials_encrypted: 'secret', config: { headless: true },
    });
    expect(Object.keys(view).sort()).toEqual(
      ['created_at', 'error', 'finished_at', 'id', 'progress', 'rows_found', 'status', 'tool'],
    );
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- jobView.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bench/jobView'`.

- [ ] **Step 3: Написать реализацию**

```ts
import type { BenchJobTool, BenchJobView, JobRow } from './types';

/**
 * Наружу отдаём только перечисленные поля. Строка таблицы задач содержит
 * `user_id`, зашифрованные прокси и внутренний `config` — им во внешнем
 * ответе не место, поэтому собираем представление явно, а не спредом.
 */
export function toBenchJobView(tool: BenchJobTool, row: JobRow): BenchJobView {
  return {
    id: String(row.id),
    tool: tool.id,
    status: tool.mapStatus(row),
    progress: tool.progress(row),
    rows_found: tool.rowsFound(row),
    error: tool.errorOf(row),
    created_at: typeof row.created_at === 'string' ? row.created_at : null,
    finished_at: tool.finishedAt(row),
  };
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- jobView.test.ts`
Expected: PASS, 2 теста.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/bench/jobView.ts app/tests/lib/bench/jobView.test.ts
git commit -m "feat(bench-api): общее представление задачи"
```

---

### Task 16: Постановка задачи `POST /jobs`

**Files:**
- Create: `app/src/app/api/bench/v1/jobs/route.ts`
- Test: `app/tests/api/benchJobsCreate.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ROBOT = '00000000-0000-4000-8000-0000000000aa';
const KEY = {
  id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234', robot_user_id: ROBOT,
  allowed_tools: ['yandexmaps'], rpm_limit: 60, daily_jobs_limit: 50,
  daily_rows_limit: 1000, max_active_jobs: 3, revoked_at: null,
};

let mockDb: MockSupabaseClient;

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
    isBenchAuth: actual.isBenchAuth,
    assertToolAllowed: actual.assertToolAllowed,
  };
});
jest.mock('@/lib/bench/limits', () => ({
  checkBenchLimits: jest.fn(async () => null),
  checkActiveJobs: jest.fn(async () => null),
}));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { POST } from '@/app/api/bench/v1/jobs/route';

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockDb = createMockSupabase({ tables: { yandex_maps_jobs: [] } });
});

describe('POST /api/bench/v1/jobs', () => {
  it('ставит задачу и отдаёт её общим представлением', async () => {
    const res = await POST(request({
      tool: 'yandexmaps',
      params: { search_urls: ['https://yandex.ru/maps/?text=кофейни'], max_results: 100 },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tool).toBe('yandexmaps');
    expect(body.status).toBe('queued');
  });

  it('владельцем задачи становится робот ключа', async () => {
    await POST(request({
      tool: 'yandexmaps',
      params: { search_urls: ['https://yandex.ru/maps/?text=кофейни'] },
    }));
    const insert = mockDb.mutations.find((m) => m.kind === 'insert')!;
    expect(insert.rows[0].user_id).toBe(ROBOT);
  });

  it('инструмент вне списка ключа не существует для него', async () => {
    const res = await POST(request({ tool: 'company-base', params: {} }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'tool_not_allowed' } });
  });

  it('неизвестный инструмент — not_found', async () => {
    const res = await POST(request({ tool: 'нет-такого', params: {} }));
    expect(res.status).toBe(404);
  });

  it('кривые параметры не создают задачу', async () => {
    const res = await POST(request({ tool: 'yandexmaps', params: { search_urls: [] } }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'invalid_params' } });
    expect(mockDb.mutations.filter((m) => m.kind === 'insert')).toHaveLength(0);
  });

  it('владельца из тела запроса игнорирует', async () => {
    await POST(request({
      tool: 'yandexmaps',
      params: { search_urls: ['https://yandex.ru/maps/?text=кофейни'], user_id: 'чужой' },
    }));
    expect(mockDb.mutations.filter((m) => m.kind === 'insert')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- benchJobsCreate.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/bench/v1/jobs/route'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { toBenchJobView } from '@/lib/bench/jobView';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkActiveJobs, checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import type { BenchJobTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ACTIVE_STATUSES = ['pending', 'queued', 'running', 'processing'];

export async function POST(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const finish = async (response: NextResponse, tool: string | null) => {
    await logBenchRequest({
      keyId: auth.key.id, tool, action: 'create_job',
      statusCode: response.status, rowsReturned: 0, durationMs: Date.now() - started,
    });
    return response;
  };

  let body: { tool?: unknown; params?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return finish(benchError('invalid_params', 'Тело запроса должно быть JSON'), null);
  }

  const toolId = typeof body.tool === 'string' ? body.tool : '';
  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(
      benchError('not_found', `Инструмент «${toolId}» не найден среди задачных`),
      toolId || null,
    );
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, tool.id);

  const limited = await checkBenchLimits(auth.key, 'create_job');
  if (limited) return finish(limited, tool.id);

  const jobTool = tool as BenchJobTool;
  const parsed = jobTool.paramsSchema.safeParse(body.params ?? {});
  if (!parsed.success) {
    return finish(
      benchError('invalid_params', 'Параметры не прошли проверку', parsed.error.issues),
      tool.id,
    );
  }

  const busy = await checkActiveJobs(
    auth.db as never, auth.key, jobTool.table, ACTIVE_STATUSES,
  );
  if (busy) return finish(busy, tool.id);

  // Владелец берётся ИЗ КЛЮЧА, не из тела запроса: подделать его нельзя.
  const row = jobTool.buildRow(parsed.data as never, auth.key.robot_user_id);
  const { data, error } = await auth.db.from(jobTool.table).insert(row).select().single();

  if (error || !data) {
    return finish(benchError('server_error', error?.message ?? 'Не удалось создать задачу'), tool.id);
  }

  return finish(NextResponse.json(toBenchJobView(jobTool, data)), tool.id);
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- benchJobsCreate.test.ts`
Expected: PASS, 6 тестов.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/api/bench/v1/jobs/route.ts app/tests/api/benchJobsCreate.test.ts
git commit -m "feat(bench-api): постановка задачи"
```

---

### Task 17: Список задач `GET /jobs`

**Files:**
- Modify: `app/src/app/api/bench/v1/jobs/route.ts` (добавить `GET` рядом с `POST`)
- Test: `app/tests/api/benchJobsList.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ROBOT = '00000000-0000-4000-8000-0000000000aa';
const KEY = {
  id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234', robot_user_id: ROBOT,
  allowed_tools: ['yandexmaps'], rpm_limit: 60, daily_jobs_limit: 50,
  daily_rows_limit: 1000, max_active_jobs: 3, revoked_at: null,
};

let mockDb: MockSupabaseClient;

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
    isBenchAuth: actual.isBenchAuth,
    assertToolAllowed: actual.assertToolAllowed,
  };
});
jest.mock('@/lib/bench/limits', () => ({
  checkBenchLimits: jest.fn(async () => null),
  checkActiveJobs: jest.fn(async () => null),
}));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { GET } from '@/app/api/bench/v1/jobs/route';

function request(query: string): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs${query}`),
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      yandex_maps_jobs: [
        { id: 'j1', user_id: ROBOT, status: 'completed', processed_organizations: 10, total_organizations: 10, created_at: '2026-08-31T09:00:00Z', completed_at: '2026-08-31T09:30:00Z' },
        { id: 'j2', user_id: ROBOT, status: 'pending', processed_organizations: 0, total_organizations: 0, created_at: '2026-08-31T10:00:00Z', completed_at: null },
      ],
    },
  });
});

describe('GET /api/bench/v1/jobs', () => {
  it('отдаёт задачи в общей форме', async () => {
    const body = await (await GET(request('?tool=yandexmaps'))).json();
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]).toHaveProperty('rows_found');
    expect(body.jobs[0]).not.toHaveProperty('user_id');
  });

  it('фильтрует по общему словарю статусов', async () => {
    const body = await (await GET(request('?tool=yandexmaps&status=done'))).json();
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(['j1']);
  });

  it('без параметра tool просит его указать', async () => {
    const res = await GET(request(''));
    expect(res.status).toBe(400);
  });

  it('инструмент вне списка ключа недоступен и в списке', async () => {
    const res = await GET(request('?tool=company-base'));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- benchJobsList.test.ts`
Expected: FAIL — `GET is not a function`.

- [ ] **Step 3: Дописать `GET` в тот же файл**

Добавить в конец `app/src/app/api/bench/v1/jobs/route.ts`:

```ts
const LIST_LIMIT = 100;

export async function GET(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const finish = async (response: NextResponse, tool: string | null, rows: number) => {
    await logBenchRequest({
      keyId: auth.key.id, tool, action: 'list_jobs',
      statusCode: response.status, rowsReturned: rows, durationMs: Date.now() - started,
    });
    return response;
  };

  const toolId = req.nextUrl.searchParams.get('tool') ?? '';
  if (!toolId) {
    return finish(
      benchError('invalid_params', 'Укажите ?tool= — список задач ведётся по инструменту'),
      null, 0,
    );
  }

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`), toolId, 0);
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, tool.id, 0);

  const limited = await checkBenchLimits(auth.key, 'read');
  if (limited) return finish(limited, tool.id, 0);

  const jobTool = tool as BenchJobTool;
  // Фильтра по user_id здесь нет намеренно: клиент привязан к роботу, и
  // чужие строки отсекает RLS. Тест изоляции (Task 21) это стережёт.
  const { data, error } = await auth.db
    .from(jobTool.table)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);

  if (error) return finish(benchError('server_error', error.message), tool.id, 0);

  const wanted = req.nextUrl.searchParams.get('status');
  const jobs = (data ?? [])
    .map((row) => toBenchJobView(jobTool, row))
    .filter((job) => !wanted || job.status === wanted);

  return finish(NextResponse.json({ jobs }), tool.id, jobs.length);
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- benchJobsList.test.ts benchJobsCreate.test.ts`
Expected: PASS — оба файла зелёные.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/api/bench/v1/jobs/route.ts app/tests/api/benchJobsList.test.ts
git commit -m "feat(bench-api): список своих задач"
```

---

### Task 18: Статус задачи `GET /jobs/{id}`

**Files:**
- Create: `app/src/app/api/bench/v1/jobs/[id]/route.ts`
- Test: `app/tests/api/benchJobStatus.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ROBOT = '00000000-0000-4000-8000-0000000000aa';
const KEY = {
  id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234', robot_user_id: ROBOT,
  allowed_tools: ['yandexmaps'], rpm_limit: 60, daily_jobs_limit: 50,
  daily_rows_limit: 1000, max_active_jobs: 3, revoked_at: null,
};

let mockDb: MockSupabaseClient;

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
    isBenchAuth: actual.isBenchAuth,
    assertToolAllowed: actual.assertToolAllowed,
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { GET } from '@/app/api/bench/v1/jobs/[id]/route';

function request(id: string, tool = 'yandexmaps'): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs/${id}?tool=${tool}`),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      yandex_maps_jobs: [
        { id: 'j1', user_id: ROBOT, status: 'running', processed_organizations: 5, total_organizations: 50, created_at: '2026-08-31T10:00:00Z', completed_at: null, error_message: null },
      ],
    },
  });
});

describe('GET /api/bench/v1/jobs/{id}', () => {
  it('отдаёт свою задачу', async () => {
    const body = await (await GET(request('j1'), ctx('j1'))).json();
    expect(body.id).toBe('j1');
    expect(body.status).toBe('running');
    expect(body.progress).toEqual({ done: 5, total: 50 });
  });

  it('чужая задача неотличима от несуществующей', async () => {
    const res = await GET(request('чужая'), ctx('чужая'));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'not_found' } });
  });

  it('не протаскивает user_id наружу', async () => {
    const body = await (await GET(request('j1'), ctx('j1'))).json();
    expect(body).not.toHaveProperty('user_id');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- benchJobStatus.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/bench/v1/jobs/[id]/route'`.

- [ ] **Step 3: Написать реализацию**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { toBenchJobView } from '@/lib/bench/jobView';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import type { BenchJobTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const { id } = await ctx.params;
  const toolId = req.nextUrl.searchParams.get('tool') ?? '';

  const finish = async (response: NextResponse) => {
    await logBenchRequest({
      keyId: auth.key.id, tool: toolId || null, action: 'job_status',
      statusCode: response.status, rowsReturned: 0, durationMs: Date.now() - started,
    });
    return response;
  };

  if (!toolId) {
    return finish(benchError('invalid_params', 'Укажите ?tool= — задачи хранятся по инструментам'));
  }

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`));
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied);

  const limited = await checkBenchLimits(auth.key, 'read');
  if (limited) return finish(limited);

  const jobTool = tool as BenchJobTool;
  const { data } = await auth.db.from(jobTool.table).select('*').eq('id', id).maybeSingle();

  // Чужая задача просто не вернётся: клиент привязан к роботу, RLS отсекает
  // её на уровне базы. Отвечаем `not_found`, а не `forbidden`, чтобы
  // перебором идентификаторов нельзя было выяснить, что существует у других.
  if (!data) return finish(benchError('not_found', 'Задача не найдена'));

  return finish(NextResponse.json(toBenchJobView(jobTool, data)));
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- benchJobStatus.test.ts`
Expected: PASS, 3 теста.

- [ ] **Step 5: Commit**

```bash
git add "app/src/app/api/bench/v1/jobs/[id]/route.ts" app/tests/api/benchJobStatus.test.ts
git commit -m "feat(bench-api): статус задачи"
```

---

### Task 19: Результаты `GET /jobs/{id}/results`

**Files:**
- Create: `app/src/app/api/bench/v1/jobs/[id]/results/route.ts`
- Test: `app/tests/api/benchJobResults.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ROBOT = '00000000-0000-4000-8000-0000000000aa';
const KEY = {
  id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234', robot_user_id: ROBOT,
  allowed_tools: ['yandexmaps'], rpm_limit: 60, daily_jobs_limit: 50,
  daily_rows_limit: 1000, max_active_jobs: 3, revoked_at: null,
};

let mockDb: MockSupabaseClient;
const logBenchRequest = jest.fn(async () => {});

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
    isBenchAuth: actual.isBenchAuth,
    assertToolAllowed: actual.assertToolAllowed,
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: (e: unknown) => logBenchRequest(e as never) }));

import { GET } from '@/app/api/bench/v1/jobs/[id]/results/route';

function request(id: string, query = ''): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs/${id}/results?tool=yandexmaps${query}`),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  logBenchRequest.mockClear();
  mockDb = createMockSupabase({
    tables: {
      yandex_maps_jobs: [{ id: 'j1', user_id: ROBOT, status: 'completed' }],
      yandex_maps_organizations: [
        { id: 'o1', job_id: 'j1', name: 'Альфа', created_at: '2026-08-31T10:00:00Z' },
        { id: 'o2', job_id: 'j1', name: 'Бета', created_at: '2026-08-31T10:00:01Z' },
      ],
    },
  });
});

describe('GET /api/bench/v1/jobs/{id}/results', () => {
  it('отдаёт строки результата', async () => {
    const body = await (await GET(request('j1'), ctx('j1'))).json();
    expect(body.rows).toHaveLength(2);
  });

  it('страницу ограничивает limit и отдаёт курсор', async () => {
    const body = await (await GET(request('j1', '&limit=1'), ctx('j1'))).json();
    expect(body.rows).toHaveLength(1);
    expect(body.has_more).toBe(true);
    expect(body.cursor).toBe('o1');
  });

  it('чужая задача — not_found, и строки не читаются', async () => {
    const res = await GET(request('чужая'), ctx('чужая'));
    expect(res.status).toBe(404);
  });

  it('считает отданные строки в журнал — по ним идёт суточная норма', async () => {
    await GET(request('j1'), ctx('j1'));
    expect(logBenchRequest).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'results', rowsReturned: 2 }),
    );
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- benchJobResults.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Написать реализацию**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import type { BenchJobTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const { id } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const toolId = sp.get('tool') ?? '';

  const finish = async (response: NextResponse, rows: number) => {
    await logBenchRequest({
      keyId: auth.key.id, tool: toolId || null, action: 'results',
      statusCode: response.status, rowsReturned: rows, durationMs: Date.now() - started,
    });
    return response;
  };

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`), 0);
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, 0);

  const limited = await checkBenchLimits(auth.key, 'results');
  if (limited) return finish(limited, 0);

  const jobTool = tool as BenchJobTool;

  // Сперва убеждаемся, что задача видна роботу. Без этого пришлось бы
  // полагаться только на RLS дочерней таблицы, а она у разных инструментов
  // написана по-разному — проверяем родителя явно.
  const { data: job } = await auth.db
    .from(jobTool.table).select('id').eq('id', id).maybeSingle();
  if (!job) return finish(benchError('not_found', 'Задача не найдена'), 0);

  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(sp.get('limit')) || DEFAULT_LIMIT));
  const cursor = sp.get('cursor');

  let query = auth.db
    .from(jobTool.results.table)
    .select('*')
    .eq(jobTool.results.jobColumn, id)
    .order('id', { ascending: true })
    .limit(limit);
  if (cursor) query = query.gt('id', cursor);

  const { data, error } = await query;
  if (error) return finish(benchError('server_error', error.message), 0);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length === limit;
  const last = rows[rows.length - 1];

  return finish(
    NextResponse.json({
      rows,
      cursor: hasMore && last ? String(last.id) : null,
      has_more: hasMore,
    }),
    rows.length,
  );
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- benchJobResults.test.ts`
Expected: PASS, 4 теста.

- [ ] **Step 5: Commit**

```bash
git add "app/src/app/api/bench/v1/jobs/[id]/results/route.ts" app/tests/api/benchJobResults.test.ts
git commit -m "feat(bench-api): результаты задачи страницами"
```

---

### Task 20: Остановка `POST /jobs/{id}/stop`

**Files:**
- Create: `app/src/app/api/bench/v1/jobs/[id]/stop/route.ts`
- Test: `app/tests/api/benchJobStop.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ROBOT = '00000000-0000-4000-8000-0000000000aa';
const KEY = {
  id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234', robot_user_id: ROBOT,
  allowed_tools: ['yandexmaps'], rpm_limit: 60, daily_jobs_limit: 50,
  daily_rows_limit: 1000, max_active_jobs: 3, revoked_at: null,
};

let mockDb: MockSupabaseClient;

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
    isBenchAuth: actual.isBenchAuth,
    assertToolAllowed: actual.assertToolAllowed,
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { POST } from '@/app/api/bench/v1/jobs/[id]/stop/route';

function request(id: string): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs/${id}/stop?tool=yandexmaps`),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: { yandex_maps_jobs: [{ id: 'j1', user_id: ROBOT, status: 'running' }] },
  });
});

describe('POST /api/bench/v1/jobs/{id}/stop', () => {
  it('на инструмент без остановки отвечает conflict с причиной', async () => {
    const res = await POST(request('j1'), ctx('j1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain('остановку');
  });

  it('ничего не меняет в таблице задач', async () => {
    await POST(request('j1'), ctx('j1'));
    expect(mockDb.mutations.filter((m) => m.kind === 'update')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- benchJobStop.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Написать реализацию**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { toBenchJobView } from '@/lib/bench/jobView';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import type { BenchJobTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STOPPABLE_FROM = ['pending', 'queued', 'running', 'processing'];

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const { id } = await ctx.params;
  const toolId = req.nextUrl.searchParams.get('tool') ?? '';

  const finish = async (response: NextResponse) => {
    await logBenchRequest({
      keyId: auth.key.id, tool: toolId || null, action: 'stop',
      statusCode: response.status, rowsReturned: 0, durationMs: Date.now() - started,
    });
    return response;
  };

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`));
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied);

  const limited = await checkBenchLimits(auth.key, 'stop');
  if (limited) return finish(limited);

  const jobTool = tool as BenchJobTool;

  // Остановку поддерживают не все инструменты: у большинства нет ни ручки,
  // ни статуса «остановлена» в ограничении таблицы. Отвечаем внятно, а
  // `GET /tools` сообщает об этом заранее, чтобы не выяснять пробами.
  if (!jobTool.stop.supported) {
    return finish(benchError('conflict', jobTool.stop.reason));
  }

  const { data: job } = await auth.db
    .from(jobTool.table).select('*').eq('id', id).maybeSingle();
  if (!job) return finish(benchError('not_found', 'Задача не найдена'));

  if (!STOPPABLE_FROM.includes(String(job.status))) {
    return finish(benchError('conflict', 'Задача уже завершена — останавливать нечего'));
  }

  const { data, error } = await auth.db
    .from(jobTool.table)
    .update({ status: jobTool.stop.stoppedStatus })
    .eq('id', id)
    .select()
    .single();

  if (error || !data) {
    return finish(benchError('server_error', error?.message ?? 'Не удалось остановить задачу'));
  }

  return finish(NextResponse.json(toBenchJobView(jobTool, data)));
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- benchJobStop.test.ts`
Expected: PASS, 2 теста.

- [ ] **Step 5: Commit**

```bash
git add "app/src/app/api/bench/v1/jobs/[id]/stop/route.ts" app/tests/api/benchJobStop.test.ts
git commit -m "feat(bench-api): остановка задачи там, где она поддерживается"
```

---

### Task 21: Поиск `POST /search`

**Files:**
- Create: `app/src/app/api/bench/v1/search/route.ts`
- Test: `app/tests/api/benchSearch.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const KEY = {
  id: 'k1', name: 'Дима', key_hash: 'h', key_last4: '1234', robot_user_id: 'r1',
  allowed_tools: ['company-base'], rpm_limit: 60, daily_jobs_limit: 50,
  daily_rows_limit: 1000, max_active_jobs: 3, revoked_at: null,
};

let mockDb: MockSupabaseClient;

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
    isBenchAuth: actual.isBenchAuth,
    assertToolAllowed: actual.assertToolAllowed,
  };
});
jest.mock('@/lib/bench/limits', () => ({ checkBenchLimits: jest.fn(async () => null) }));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { POST } from '@/app/api/bench/v1/search/route';

function request(body: unknown): NextRequest {
  return { headers: { get: () => null }, json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      pdl_companies: [
        { id: 'c1', name: 'Alpha', country: 'russia', industry: 'software', size: '11-50' },
        { id: 'c2', name: 'Beta', country: 'germany', industry: 'retail', size: '51-200' },
      ],
    },
  });
});

describe('POST /api/bench/v1/search', () => {
  it('ищет и отдаёт страницу', async () => {
    const body = await (await POST(request({ source: 'company-base', filters: {} }))).json();
    expect(body.rows).toHaveLength(2);
    expect(body).toHaveProperty('has_more');
  });

  it('кривые фильтры — invalid_params', async () => {
    const res = await POST(request({ source: 'company-base', filters: { drop: 1 } }));
    expect(res.status).toBe(400);
  });

  it('источник вне списка ключа недоступен', async () => {
    const res = await POST(request({ source: 'yandexmaps', filters: {} }));
    expect([403, 404]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm --prefix app test -- benchSearch.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Написать реализацию**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import type { BenchSearchTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export async function POST(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  let body: { source?: unknown; filters?: unknown; limit?: unknown; cursor?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return benchError('invalid_params', 'Тело запроса должно быть JSON');
  }

  const sourceId = typeof body.source === 'string' ? body.source : '';

  const finish = async (response: NextResponse, rows: number) => {
    await logBenchRequest({
      keyId: auth.key.id, tool: sourceId || null, action: 'search',
      statusCode: response.status, rowsReturned: rows, durationMs: Date.now() - started,
    });
    return response;
  };

  const tool = getBenchTool(sourceId);
  if (!tool || tool.kind !== 'search') {
    return finish(benchError('not_found', `Источник «${sourceId}» не найден среди поисковых`), 0);
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, 0);

  const limited = await checkBenchLimits(auth.key, 'search');
  if (limited) return finish(limited, 0);

  const searchTool = tool as BenchSearchTool;
  const parsed = searchTool.filtersSchema.safeParse(body.filters ?? {});
  if (!parsed.success) {
    return finish(benchError('invalid_params', 'Фильтры не прошли проверку', parsed.error.issues), 0);
  }

  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(body.limit) || DEFAULT_LIMIT));
  const cursor = typeof body.cursor === 'string' ? body.cursor : null;

  try {
    const page = await searchTool.run({
      db: auth.db, filters: parsed.data as never, limit, cursor,
    });
    return finish(NextResponse.json(page), page.rows.length);
  } catch (e) {
    return finish(benchError('server_error', e instanceof Error ? e.message : 'Поиск не удался'), 0);
  }
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm --prefix app test -- benchSearch.test.ts`
Expected: PASS, 3 теста.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/api/bench/v1/search/route.ts app/tests/api/benchSearch.test.ts
git commit -m "feat(bench-api): поиск по готовым данным"
```

---

### Task 22: Сторож изоляции

Это главный тест плана. Он стережёт обещание, ради которого витрина затевалась.

**Files:**
- Test: `app/tests/api/benchIsolation.test.ts`

- [ ] **Step 1: Написать тест**

```ts
/** @jest-environment node */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BENCH_ROUTES = join(process.cwd(), 'src/app/api/bench');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('изоляция витрины', () => {
  const files = walk(BENCH_ROUTES).filter((f) => f.endsWith('.ts'));

  it('роуты витрины существуют', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('ни один роут не ходит в данные сервисным ключом', () => {
    // supabaseAdmin обходит RLS. Роуты обязаны работать через клиент робота
    // (auth.db) — иначе изоляцию сторожит только наш код, а не база.
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('supabaseAdmin'));
    expect(offenders).toEqual([]);
  });

  it('ни один роут не собирает клиент в обход createBenchDb', () => {
    const offenders = files.filter((f) =>
      readFileSync(f, 'utf8').includes('createAuthedSupabaseClient'),
    );
    expect(offenders).toEqual([]);
  });

  it('владелец задачи нигде не берётся из тела запроса', () => {
    const offenders = files.filter((f) => /body\.\w*user_id/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Прогнать тест**

Run: `npm --prefix app test -- benchIsolation.test.ts`
Expected: PASS, 4 теста. Если падает — роут обошёл `auth.db`; чинить роут, а не тест.

- [ ] **Step 3: Прогнать всё вместе**

Run: `npm --prefix app test -- bench`
Expected: PASS — все файлы витрины зелёные.

- [ ] **Step 4: Проверить типы и линтер**

Run: `npm --prefix app run typecheck:strict && npm --prefix app run lint`
Expected: обе команды завершаются без ошибок.

- [ ] **Step 5: Commit**

```bash
git add app/tests/api/benchIsolation.test.ts
git commit -m "test(bench-api): сторож изоляции витрины"
```

---

### Task 23: Скрипт выдачи ключа

Экран в админке — в следующем плане, а проверить основание руками нужно уже сейчас. Скрипт заводит робота и ключ и печатает ключ ровно один раз.

Задачу можно выполнять в любой момент после Task 2.

**Files:**
- Create: `app/scripts/bench/issue-key.mjs`

- [ ] **Step 1: Написать скрипт**

```js
/**
 * Выдача ключа Bench API из командной строки.
 *
 *   node --env-file ../.env scripts/bench/issue-key.mjs "Дима" yandexmaps,company-base
 *
 * Заводит учётку-робота (без пароля — войти под ней нельзя) и ключ к ней.
 * Ключ печатается ОДИН раз: в базе лежит только его отпечаток.
 *
 * Временная мера до экрана «Ключи API» в админке.
 */
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';

const [name, toolsArg] = process.argv.slice(2);
if (!name || !toolsArg) {
  console.error('Использование: issue-key.mjs "<имя получателя>" <инструменты через запятую>');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const tools = toolsArg.split(',').map((t) => t.trim()).filter(Boolean);

const slug = randomBytes(4).toString('hex');
const email = `bench-robot-${slug}@robots.invalid`;

const { data: created, error: userError } = await admin.auth.admin.createUser({
  email,
  email_confirm: true,
  password: randomBytes(32).toString('base64url'),
  user_metadata: { bench_robot: true, issued_for: name },
});
if (userError) {
  console.error('Не удалось создать робота:', userError.message);
  process.exit(1);
}
const robotId = created.user.id;

const { error: profileError } = await admin
  .from('profiles')
  .upsert({ id: robotId, email, role: null, is_api_robot: true }, { onConflict: 'id' });
if (profileError) {
  console.error('Не удалось завести профиль робота:', profileError.message);
  process.exit(1);
}

const key = `bench_live_${randomBytes(24).toString('base64url')}`;
const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');

const { error: keyError } = await admin.from('bench_api_keys').insert({
  name,
  key_hash: keyHash,
  key_last4: key.slice(-4),
  robot_user_id: robotId,
  allowed_tools: tools,
});
if (keyError) {
  console.error('Не удалось создать ключ:', keyError.message);
  process.exit(1);
}

console.log('Ключ выдан. Он показывается один раз — сохраните сейчас:\n');
console.log(`  ${key}\n`);
console.log(`  получатель:   ${name}`);
console.log(`  робот:        ${robotId}`);
console.log(`  инструменты:  ${tools.join(', ')}`);
```

- [ ] **Step 2: Выдать ключ себе и проверить каталог**

Run:

```bash
node --env-file ../.env app/scripts/bench/issue-key.mjs "Проверка" yandexmaps,company-base
```

Expected: печатает ключ `bench_live_…`, идентификатор робота и список инструментов.

- [ ] **Step 3: Проверить витрину живым запросом**

Run (подставьте выданный ключ):

```bash
curl -s -H "Authorization: Bearer <ключ>" http://localhost:3000/api/bench/v1/tools
```

Expected: JSON со списком из двух инструментов; у `yandexmaps` поле `stop_supported: false`.

- [ ] **Step 4: Проверить, что отозванный ключ отваливается сразу**

Отозвать ключ запросом к базе (`update bench_api_keys set revoked_at = now()`), затем повторить curl из шага 3.
Expected: `401` с телом `{"error":{"code":"unauthorized","message":"Ключ отозван","details":null}}`.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/bench/issue-key.mjs
git commit -m "feat(bench-api): скрипт выдачи ключа до появления админки"
```

---

## Что остаётся следующему плану

- 10 задачных адаптеров: `base-constructor`, `googlemaps`, `googlenews`, `hh`, `hh-archive`, `ats`, `eng-hiring`, `search`, `yandex-direct`, `tg-parser`, `inn-enrich`.
- 2 поисковых: `2gis`, `our-bases`.
- Режим каталожного поиска для `yandexmaps`.
- `POST /search/count` вместе с механизмом оценки числа строк — точный подсчёт по `pdl_companies` (13 млн строк) недопустим, портал использует оценку планировщика.
- Экран «Ключи API» в админке; после него скрипт из Task 23 становится ненужным.
- Чистка журнала старше 90 дней (спека §8) — крон рядом с остальными в `app/src/app/api/cron/`.
- Документация: файл в репозитории, страница по ссылке, примеры на curl и Python.

## Перед выкаткой на прод

`SUPABASE_JWT_SECRET` должен появиться в окружении приложения — без него витрина не выпустит токен робота и ответит `server_error` на каждый запрос. Значение берётся из конфигурации self-hosted Supabase на `139.60.162.12` (тот же секрет, которым подписывает GoTrue). Деплой и правку окружения выполняет пользователь.
