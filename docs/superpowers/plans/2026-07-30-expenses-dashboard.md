# Расходы: доступ, API и дашборд — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вкладка «Расходы» в портале: закрытая ролью и точечной выдачей, с разбивкой по сервисам, очередью разметки и формой ручного ввода трат с личной карты CEO.

**Architecture:** Данные читает только серверный код под `service_role` через API-роуты с общим гардом — скрытый пункт меню защитой не считается. Агрегация делается в TypeScript над строками витрины `expenses_v` чистыми функциями, которые покрыты юнит-тестами; SQL остаётся простым выборочным запросом.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind 4, recharts, Supabase JS, jest + Testing Library.

**Требует:** выполненного `docs/superpowers/plans/2026-07-30-expenses-data-layer.md`
**Спека:** `docs/superpowers/specs/2026-07-30-expenses-dashboard-design.md`

---

## Ориентация в коде

- `app/src/lib/toolsRegistry.ts` — `ALL_NAV_TAB_IDS`, `NAV_TABS_CONFIG`, реестры инструментов.
- `app/src/lib/navigation.ts` — `navItems`, тип `NavItem`.
- `app/src/components/TopNav.tsx:31-40` и `app/src/components/Sidebar.tsx:94-100` — фильтрация пунктов навигации, две копии одной логики.
- `app/src/lib/UserProvider.tsx:114-119` — `navTabVisibility`, дефолт для nav-вкладок `false`.
- `app/src/app/admin/users/page.tsx:1886` — свёрнутый в `<details>` блок инструментов, `:1921` — плоский блок вкладок.
- `app/src/lib/salesChatAnalyzer/apiGuard.ts` — эталон гарда доступа к API.
- `app/src/lib/supabaseAdmin.ts` — `supabaseAdmin` (service_role), `app/src/lib/supabaseRouteClient.ts` — `getBearerToken`, `createAuthedSupabaseClient`.
- Тесты — `app/tests/**`, запуск `cd app && npx jest <path>`.

---

## Структура файлов

**Создаём:**

| Файл | Ответственность |
|---|---|
| `app/src/lib/expenses/access.ts` | Гард `requireExpensesAccess` для всех роутов расходов |
| `app/src/lib/expenses/period.ts` | Разбор диапазона дат, предыдущий период, ключ бакета |
| `app/src/lib/expenses/aggregate.ts` | Чистые агрегации: итоги, ряд по времени, разбивка по вендорам |
| `app/src/lib/expenses/rows.ts` | Постраничная выборка строк `expenses_v` под service_role |
| `app/src/lib/expenses/types.ts` | Типы строки расхода и ответов API |
| `app/src/lib/expenses/client.ts` | Клиентский `authedFetch` к `/api/expenses/*` |
| `app/src/app/api/expenses/summary/route.ts` | KPI и ряд по времени |
| `app/src/app/api/expenses/vendors/route.ts` | Разбивка по вендорам (GET) и создание вендора (POST) |
| `app/src/app/api/expenses/transactions/route.ts` | Drill-down по вендору |
| `app/src/app/api/expenses/unclassified/route.ts` | Очередь разметки |
| `app/src/app/api/expenses/classify/route.ts` | Разметка + опциональное создание правила |
| `app/src/app/api/expenses/manual/route.ts` | Список и создание ручных трат |
| `app/src/app/api/expenses/manual/[id]/route.ts` | Правка и удаление ручной траты |
| `app/src/app/api/expenses/export/route.ts` | Выгрузка периода в xlsx |
| `app/src/app/expenses/page.tsx` | Страница дашборда |
| `app/src/components/expenses/Filters.tsx` | Период, группировка, фильтры |
| `app/src/components/expenses/KpiRow.tsx` | Итог, среднее, дельта, неразмеченное, перемещения |
| `app/src/components/expenses/TimeChart.tsx` | Stacked bar по времени |
| `app/src/components/expenses/VendorBreakdown.tsx` | Бары топ-15 и таблица с drill-down |
| `app/src/components/expenses/ClassifyQueue.tsx` | Очередь разметки |
| `app/src/components/expenses/ManualExpenseForm.tsx` | Форма и список ручных трат |
| `app/tests/lib/expensesPeriod.test.ts` | Тесты периода и бакетов |
| `app/tests/lib/expensesAggregate.test.ts` | Тесты агрегаций |
| `app/tests/lib/expensesNavVisibility.test.ts` | Тесты видимости вкладки |
| `app/tests/api/expensesAccess.test.ts` | Тесты гарда |
| `app/tests/api/expensesManualRoute.test.ts` | Тесты прав на правку ручных трат |

**Правим:**

| Файл | Что |
|---|---|
| `app/src/lib/toolsRegistry.ts` | `nav-expenses`, поле `adminAlwaysOn` в `NavTabConfig` |
| `app/src/lib/navigation.ts` | Пункт «Расходы», чистый хелпер `isNavTabVisible` |
| `app/src/components/TopNav.tsx` | Использовать хелпер |
| `app/src/components/Sidebar.tsx` | Использовать хелпер |
| `app/src/app/admin/users/page.tsx` | Блок вкладок в `<details>` с описаниями |
| `app/src/lib/globalTranslations.ts` | Пары ru→en для новых строк |
| `app/package.json` | Зависимость `recharts` |

---

## Фаза 1 — Доступ

### Task 1: Реестр вкладки и правило видимости

**Files:**
- Modify: `app/src/lib/toolsRegistry.ts:8-23`
- Modify: `app/src/lib/navigation.ts`
- Test: `app/tests/lib/expensesNavVisibility.test.ts`

Сейчас правило видимости nav-вкладок продублировано в `TopNav.tsx:36` и `Sidebar.tsx:99` и про роли ничего не знает. Выносим его в чистую функцию — иначе «админ видит всегда» придётся писать дважды и один раз забыть.

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/expensesNavVisibility.test.ts`:

```ts
/** @jest-environment node */

import { isNavTabVisible } from '@/lib/navigation';

describe('isNavTabVisible', () => {
  it('прячет вкладку расходов, если тумблер не выдан', () => {
    expect(isNavTabVisible('nav-expenses', 'manager', {})).toBe(false);
  });

  it('показывает вкладку расходов, если тумблер выдан', () => {
    expect(isNavTabVisible('nav-expenses', 'manager', { 'nav-expenses': true })).toBe(true);
  });

  it('показывает вкладку расходов админу без строки в БД', () => {
    // adminAlwaysOn: иначе админ не увидел бы вкладку, которую сам же выдаёт.
    expect(isNavTabVisible('nav-expenses', 'admin', {})).toBe(true);
  });

  it('не меняет поведение Доски: у неё adminAlwaysOn нет', () => {
    expect(isNavTabVisible('nav-tasks-board', 'admin', {})).toBe(false);
    expect(isNavTabVisible('nav-tasks-board', 'admin', { 'nav-tasks-board': true })).toBe(true);
  });

  it('неизвестный id не прячет пункт', () => {
    expect(isNavTabVisible('nav-unknown', 'manager', {})).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

```bash
cd app && npx jest tests/lib/expensesNavVisibility.test.ts
```

Ожидается: FAIL — `isNavTabVisible is not a function`.

- [ ] **Step 3: Расширить реестр вкладок**

В `app/src/lib/toolsRegistry.ts` заменить блок `ALL_NAV_TAB_IDS` / `NavTabConfig` / `NAV_TABS_CONFIG` (строки 7-23) на:

```ts
/** Идентификаторы вкладок боковой панели, управляемых через admin */
export const ALL_NAV_TAB_IDS = ['nav-tasks-board', 'nav-expenses'] as const;
export type NavTabId = (typeof ALL_NAV_TAB_IDS)[number];

export interface NavTabConfig {
  id: NavTabId;
  title: string;
  description: string;
  /**
   * Вкладка всегда видна админу, даже без строки в user_tool_visibility.
   * Нужно там, где админ сам раздаёт доступ: иначе он не увидит вкладку,
   * тумблер которой выдаёт другим.
   */
  adminAlwaysOn?: boolean;
}

export const NAV_TABS_CONFIG: Record<NavTabId, NavTabConfig> = {
  'nav-tasks-board': {
    id: 'nav-tasks-board',
    title: 'Доска',
    description: 'Отдельный пункт в боковой панели для открытия доски задач',
  },
  'nav-expenses': {
    id: 'nav-expenses',
    title: 'Расходы',
    description: 'Дашборд расходов по сервисам. Содержит ФОТ и налоги — выдавать точечно',
    adminAlwaysOn: true,
  },
};
```

- [ ] **Step 4: Добавить чистый хелпер в `navigation.ts`**

В `app/src/lib/navigation.ts` добавить импорты в начало файла:

```ts
import { NAV_TABS_CONFIG, type NavTabId } from '@/lib/toolsRegistry';
import type { UserRole } from '@/types';
```

и функцию в конец файла:

```ts
/**
 * Видна ли nav-вкладка пользователю.
 *
 * Дефолт для nav-вкладок — выключено (UserProvider пишет `?? false`), поэтому
 * отсутствие строки означает «не выдано». Исключение — вкладки с adminAlwaysOn.
 */
export function isNavTabVisible(
  navTabId: string,
  role: UserRole | null,
  navTabVisibility: Record<string, boolean>,
): boolean {
  const config = NAV_TABS_CONFIG[navTabId as NavTabId];
  if (!config) return true;
  if (config.adminAlwaysOn && role === 'admin') return true;
  return navTabVisibility[navTabId] === true;
}
```

- [ ] **Step 5: Запустить тест**

```bash
cd app && npx jest tests/lib/expensesNavVisibility.test.ts
```

Ожидается: 5 passed.

- [ ] **Step 6: Коммит**

```bash
git add app/src/lib/toolsRegistry.ts app/src/lib/navigation.ts app/tests/lib/expensesNavVisibility.test.ts
git commit -m "feat(expenses): реестр вкладки расходов и правило видимости"
```

---

### Task 2: Пункт навигации и переход компонентов на хелпер

**Files:**
- Modify: `app/src/lib/navigation.ts`
- Modify: `app/src/components/TopNav.tsx:36`
- Modify: `app/src/components/Sidebar.tsx:99`

- [ ] **Step 1: Добавить пункт меню**

В `app/src/lib/navigation.ts` в массив `navItems` после строки с `finance` вставить:

```ts
  { id: 'expenses', name: 'Расходы', nameEn: 'Expenses', href: '/expenses', navTabId: 'nav-expenses' },
```

- [ ] **Step 2: Переключить TopNav**

В `app/src/components/TopNav.tsx` добавить `isNavTabVisible` в существующий импорт из `@/lib/navigation` (список импортируемых имён не менять — только дописать новое) и заменить строку 36:

```ts
    if (item.navTabId && !isNavTabVisible(item.navTabId, userRole, navTabVisibility)) return false;
```

- [ ] **Step 3: Переключить Sidebar**

В `app/src/components/Sidebar.tsx` добавить `isNavTabVisible` в существующий импорт из `@/lib/navigation` и заменить строку 99:

```ts
          if (item.navTabId && !isNavTabVisible(item.navTabId, userRole, navTabVisibility)) return null;
```

- [ ] **Step 4: Проверить типы и тесты**

```bash
cd app && npx tsc --noEmit && npx jest tests/lib/expensesNavVisibility.test.ts
```

Ожидается: tsc без ошибок, 5 passed.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/navigation.ts app/src/components/TopNav.tsx app/src/components/Sidebar.tsx
git commit -m "feat(expenses): пункт меню и единое правило видимости вкладок"
```

---

### Task 3: Блок вкладок в админ-модалке

**Files:**
- Modify: `app/src/app/admin/users/page.tsx:1920-1949`

Блок инструментов уже свёрнут в `<details>`; блок вкладок остался плоским списком и с появлением второй вкладки его надо привести к тому же виду.

- [ ] **Step 1: Заменить блок**

В `app/src/app/admin/users/page.tsx` заменить `<div>` с заголовком «Отображение вкладок в Header-е» целиком на:

```tsx
                  {/* Тот же паттерн, что у блока инструментов выше: <details>
                      без React-стейта, состояние живёт в DOM. */}
                  <details className="group rounded-lg border border-gray-200 bg-gray-50/50">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-gray-100 transition-colors rounded-lg">
                      <h4 className="text-sm font-medium text-gray-900 m-0">Отображение вкладок в Header-е</h4>
                      <span className="text-gray-400 text-xs transition-transform group-open:rotate-90" aria-hidden>▶</span>
                    </summary>
                    <p className="text-xs text-gray-500 px-3 pt-1">Управляет дополнительными пунктами навигации для данного пользователя</p>
                    <ul className="space-y-2 px-3 pb-3 pt-2">
                      {ALL_NAV_TAB_IDS.map((tabId) => (
                        <li key={tabId} className="flex items-start justify-between gap-4">
                          <span className="min-w-0">
                            <span className="block text-sm text-gray-700">{NAV_TABS_CONFIG[tabId].title}</span>
                            <span className="block text-[11px] text-gray-500">{NAV_TABS_CONFIG[tabId].description}</span>
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={toolVisibility[tabId] === true}
                            aria-label={NAV_TABS_CONFIG[tabId].title}
                            onClick={() =>
                              setToolVisibility((prev) => ({
                                ...prev,
                                [tabId]: prev[tabId] !== true,
                              }))
                            }
                            className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                              toolVisibility[tabId] === true ? 'bg-blue-600' : 'bg-gray-200'
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                                toolVisibility[tabId] === true ? 'translate-x-5' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
```

Обрати внимание на смену условия с `!== false` на `=== true`: у nav-вкладок дефолт выключенный (`api/admin/users/[id]/tools/route.ts:65` отдаёт `false` при отсутствии строки), и старое `!== false` рисовало бы новый тумблер включённым, пока пользователь его не тронет.

- [ ] **Step 2: Проверить типы и сборку**

```bash
cd app && npx tsc --noEmit && npm run lint
```

Ожидается: без ошибок.

- [ ] **Step 3: Проверить руками**

Открыть `/admin/users`, зайти в модалку любого пользователя. Ожидается: блок «Отображение вкладок в Header-е» свёрнут, разворачивается кликом, внутри «Доска» и «Расходы» с описаниями, оба тумблера выключены.

- [ ] **Step 4: Коммит**

```bash
git add app/src/app/admin/users/page.tsx
git commit -m "feat(expenses): вкладки в админ-модалке свёрнуты и дополнены расходами"
```

---

### Task 4: Гард доступа к API расходов

**Files:**
- Create: `app/src/lib/expenses/access.ts`
- Test: `app/tests/api/expensesAccess.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/api/expensesAccess.test.ts`:

```ts
/** @jest-environment node */

import { NextRequest } from 'next/server';

const state: {
  user: { id: string } | null;
  profile: { role: string } | null;
  visibility: { enabled: boolean } | null;
} = { user: { id: 'u-1' }, profile: { role: 'manager' }, visibility: null };

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => (header ? 'tok' : null),
  createAuthedSupabaseClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: state.profile }),
          eq: () => ({ maybeSingle: async () => ({ data: state.visibility }) }),
        }),
      }),
    }),
  },
}));

import { requireExpensesAccess } from '@/lib/expenses/access';

function req(withAuth = true) {
  return new NextRequest('http://localhost/api/expenses/summary', {
    headers: withAuth ? { authorization: 'Bearer tok' } : {},
  });
}

beforeEach(() => {
  state.user = { id: 'u-1' };
  state.profile = { role: 'manager' };
  state.visibility = null;
});

it('401 без токена', async () => {
  const res = await requireExpensesAccess(req(false));
  expect(res).toMatchObject({ ok: false, status: 401 });
});

it('403 пользователю без выданного тумблера', async () => {
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: false, status: 403 });
});

it('403 пользователю с выключенным тумблером', async () => {
  state.visibility = { enabled: false };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: false, status: 403 });
});

it('пропускает пользователя с выданным тумблером', async () => {
  state.visibility = { enabled: true };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: true, userId: 'u-1', role: 'manager' });
});

it('пропускает админа без строки в БД', async () => {
  state.profile = { role: 'admin' };
  const res = await requireExpensesAccess(req());
  expect(res).toMatchObject({ ok: true, role: 'admin' });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

```bash
cd app && npx jest tests/api/expensesAccess.test.ts
```

Ожидается: FAIL — модуль `@/lib/expenses/access` не найден.

- [ ] **Step 3: Реализовать гард**

Создать `app/src/lib/expenses/access.ts`:

```ts
import 'server-only';

import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { UserRole } from '@/types';

/**
 * Гард доступа к расходам.
 *
 * Совпадает с правилом видимости вкладки (`isNavTabVisible` в lib/navigation):
 * админ проходит всегда, остальным нужен выданный тумблер nav-expenses.
 * Скрытый пункт меню защитой не является — данные закрыты здесь.
 */
export const EXPENSES_NAV_TAB_ID = 'nav-expenses';

export type ExpensesGuardResult =
  | { ok: true; userId: string; role: UserRole | null }
  | { ok: false; status: number; error: string };

export async function requireExpensesAccess(req: NextRequest): Promise<ExpensesGuardResult> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { ok: false, status: 401, error: 'Unauthorized' };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };

  if (!supabaseAdmin) return { ok: false, status: 500, error: 'Server misconfigured' };

  const [{ data: profile }, { data: visibility }] = await Promise.all([
    supabaseAdmin.from('profiles').select('role').eq('id', user.id).single(),
    supabaseAdmin
      .from('user_tool_visibility')
      .select('enabled')
      .eq('user_id', user.id)
      .eq('tool_id', EXPENSES_NAV_TAB_ID)
      .maybeSingle(),
  ]);

  const role = (profile?.role ?? null) as UserRole | null;

  if (role !== 'admin' && visibility?.enabled !== true) {
    return {
      ok: false,
      status: 403,
      error: 'Доступ к расходам не выдан. Попроси админа включить вкладку в твоём профиле.',
    };
  }

  return { ok: true, userId: user.id, role };
}
```

- [ ] **Step 4: Запустить тест**

```bash
cd app && npx jest tests/api/expensesAccess.test.ts
```

Ожидается: 5 passed.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/expenses/access.ts app/tests/api/expensesAccess.test.ts
git commit -m "feat(expenses): серверный гард доступа"
```

---

## Фаза 2 — API

### Task 5: Период и бакеты

**Files:**
- Create: `app/src/lib/expenses/period.ts`
- Test: `app/tests/lib/expensesPeriod.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/expensesPeriod.test.ts`:

```ts
/** @jest-environment node */

import { parseRange, previousRange, bucketKey } from '@/lib/expenses/period';

describe('parseRange', () => {
  it('принимает корректный диапазон', () => {
    expect(parseRange('2026-07-01', '2026-07-31')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('отвергает перевёрнутый диапазон', () => {
    expect(() => parseRange('2026-07-31', '2026-07-01')).toThrow();
  });

  it('отвергает мусор вместо даты', () => {
    expect(() => parseRange('вчера', '2026-07-01')).toThrow();
  });
});

describe('previousRange', () => {
  it('июль отдаёт предыдущий 31 день, вплотную до 1 июля', () => {
    expect(previousRange('2026-07-01', '2026-07-31')).toEqual({ from: '2026-05-31', to: '2026-06-30' });
  });

  it('один день отдаёт предыдущий день', () => {
    expect(previousRange('2026-07-15', '2026-07-15')).toEqual({ from: '2026-07-14', to: '2026-07-14' });
  });
});

describe('bucketKey', () => {
  it('день — сама дата', () => {
    expect(bucketKey('2026-07-15', 'day')).toBe('2026-07-15');
  });

  it('неделя — понедельник этой недели', () => {
    // 15 июля 2026 — среда.
    expect(bucketKey('2026-07-15', 'week')).toBe('2026-07-13');
  });

  it('неделя не уезжает через границу месяца', () => {
    // 1 августа 2026 — суббота, её неделя начинается 27 июля.
    expect(bucketKey('2026-08-01', 'week')).toBe('2026-07-27');
  });

  it('месяц — первое число', () => {
    expect(bucketKey('2026-07-15', 'month')).toBe('2026-07-01');
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

```bash
cd app && npx jest tests/lib/expensesPeriod.test.ts
```

Ожидается: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать**

Создать `app/src/lib/expenses/period.ts`:

```ts
import { addDays, differenceInCalendarDays, format, parseISO, startOfMonth, startOfWeek } from 'date-fns';

export type GroupBy = 'day' | 'week' | 'month';

export const GROUP_BY_VALUES: readonly GroupBy[] = ['day', 'week', 'month'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Даты приходят и хранятся как YYYY-MM-DD в поясе Москвы (`occurred_on_msk`
 * витрины уже посчитан там же). Поэтому здесь ни таймзон, ни UTC-сдвигов:
 * работаем со строками и календарными днями.
 */
export function parseRange(from: string, to: string): { from: string; to: string } {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new Error('Ожидается диапазон дат в формате YYYY-MM-DD');
  }
  if (from > to) {
    throw new Error('Начало диапазона позже конца');
  }
  return { from, to };
}

/** Предыдущий период той же длины, вплотную до начала текущего. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const start = parseISO(from);
  const end = parseISO(to);
  const lengthDays = differenceInCalendarDays(end, start) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(lengthDays - 1));
  return { from: format(prevStart, 'yyyy-MM-dd'), to: format(prevEnd, 'yyyy-MM-dd') };
}

/** Ключ бакета для группировки: начало дня, недели (с понедельника) или месяца. */
export function bucketKey(day: string, groupBy: GroupBy): string {
  const d = parseISO(day);
  if (groupBy === 'day') return day;
  if (groupBy === 'week') return format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  return format(startOfMonth(d), 'yyyy-MM-dd');
}
```

- [ ] **Step 4: Запустить тест**

```bash
cd app && npx jest tests/lib/expensesPeriod.test.ts
```

Ожидается: 9 passed.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/expenses/period.ts app/tests/lib/expensesPeriod.test.ts
git commit -m "feat(expenses): разбор периода и ключи группировки"
```

---

### Task 6: Типы и агрегации

**Files:**
- Create: `app/src/lib/expenses/types.ts`
- Create: `app/src/lib/expenses/aggregate.ts`
- Test: `app/tests/lib/expensesAggregate.test.ts`

- [ ] **Step 1: Завести типы**

Создать `app/src/lib/expenses/types.ts`:

```ts
export type ExpenseSource = 'tochka' | 'tbank' | 'brocard' | 'manual';

export type ExpenseCategory =
  | 'payroll' | 'marketing' | 'tools' | 'taxes' | 'operations' | 'transfer' | 'other';

/** Категории, которые не расход, а перемещение уже учтённых денег. */
export const TRANSFER_CATEGORIES: readonly ExpenseCategory[] = ['transfer'] as const;

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  payroll: 'ФОТ',
  marketing: 'Маркетинг',
  tools: 'Сервисы и подписки',
  taxes: 'Налоги',
  operations: 'Операционка',
  transfer: 'Перемещения',
  other: 'Прочее',
};

/** Строка витрины expenses_v. */
export interface ExpenseRow {
  source: ExpenseSource;
  source_ref: string;
  occurred_on_msk: string;
  amount: number;
  currency: string;
  counterparty: string | null;
  counterparty_inn: string | null;
  details: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  category: ExpenseCategory | null;
  classification_method: 'rule' | 'manual' | null;
  amount_rub: number | null;
}

export interface SeriesPoint {
  bucket: string;
  total: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
}

export interface ExpensesSummary {
  total: number;
  avgPerDay: number;
  deltaPrev: number | null;
  transfersTotal: number;
  unclassifiedCount: number;
  unclassifiedTotal: number;
  unconvertedCount: number;
  series: SeriesPoint[];
}

export interface VendorBreakdownItem {
  vendorId: string | null;
  vendorName: string;
  category: ExpenseCategory | null;
  total: number;
  ops: number;
  share: number;
  deltaPrev: number | null;
}
```

- [ ] **Step 2: Написать падающий тест**

Создать `app/tests/lib/expensesAggregate.test.ts`:

```ts
/** @jest-environment node */

import { summarize, breakdownByVendor } from '@/lib/expenses/aggregate';
import type { ExpenseRow } from '@/lib/expenses/types';

function row(over: Partial<ExpenseRow>): ExpenseRow {
  return {
    source: 'tochka',
    source_ref: 'r1',
    occurred_on_msk: '2026-07-15',
    amount: 100,
    currency: 'RUB',
    counterparty: 'ООО Ромашка',
    counterparty_inn: null,
    details: null,
    vendor_id: 'v1',
    vendor_name: 'OpenAI',
    category: 'tools',
    classification_method: 'rule',
    amount_rub: 100,
    ...over,
  };
}

describe('summarize', () => {
  it('перемещения не попадают в итог, но считаются отдельно', () => {
    const s = summarize(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        row({ source_ref: 'b', amount_rub: 900, category: 'transfer', vendor_name: 'Пополнение Brocard' }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(100);
    expect(s.transfersTotal).toBe(900);
  });

  it('перемещения не попадают и в ряд по времени', () => {
    const s = summarize(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        row({ source_ref: 'b', amount_rub: 900, category: 'transfer' }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.series).toEqual([
      { bucket: '2026-07-15', total: 100, byCategory: { tools: 100 }, bySource: { tochka: 100 } },
    ]);
  });

  it('неразмеченное входит в итог и отдельно подсвечивается', () => {
    const s = summarize(
      [row({ amount_rub: 250, vendor_id: null, vendor_name: null, category: null, classification_method: null })],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(250);
    expect(s.unclassifiedCount).toBe(1);
    expect(s.unclassifiedTotal).toBe(250);
  });

  it('строка без курса считается отдельно и не ломает итог', () => {
    const s = summarize(
      [
        row({ source_ref: 'a', amount_rub: 100 }),
        row({ source_ref: 'b', currency: 'USD', amount: 10, amount_rub: null }),
      ],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      null,
    );
    expect(s.total).toBe(100);
    expect(s.unconvertedCount).toBe(1);
  });

  it('среднее в день делится на длину периода, а не на число операций', () => {
    const s = summarize(
      [row({ amount_rub: 310 })],
      'day',
      { from: '2026-07-01', to: '2026-07-31' },
      null,
    );
    expect(s.avgPerDay).toBe(10);
  });

  it('дельта к прошлому периоду в долях', () => {
    const s = summarize(
      [row({ amount_rub: 150 })],
      'day',
      { from: '2026-07-15', to: '2026-07-15' },
      [row({ source_ref: 'p', amount_rub: 100 })],
    );
    expect(s.deltaPrev).toBeCloseTo(0.5);
  });

  it('дельта не считается, если в прошлом периоде нечего сравнивать', () => {
    const s = summarize([row({ amount_rub: 150 })], 'day', { from: '2026-07-15', to: '2026-07-15' }, []);
    expect(s.deltaPrev).toBeNull();
  });
});

describe('breakdownByVendor', () => {
  it('складывает вендоров, считает долю и дельту', () => {
    const items = breakdownByVendor(
      [
        row({ source_ref: 'a', amount_rub: 300 }),
        row({ source_ref: 'b', amount_rub: 100, vendor_id: 'v2', vendor_name: 'Instantly' }),
      ],
      [row({ source_ref: 'p', amount_rub: 200 })],
    );
    expect(items[0]).toMatchObject({ vendorName: 'OpenAI', total: 300, ops: 1, share: 0.75, deltaPrev: 0.5 });
    expect(items[1]).toMatchObject({ vendorName: 'Instantly', total: 100, deltaPrev: null });
  });

  it('неразмеченное собирается в одну строку', () => {
    const items = breakdownByVendor(
      [row({ vendor_id: null, vendor_name: null, category: null, amount_rub: 50 })],
      [],
    );
    expect(items[0]).toMatchObject({ vendorId: null, vendorName: 'Без категории', total: 50 });
  });

  it('перемещения в разбивку не попадают', () => {
    const items = breakdownByVendor([row({ category: 'transfer', amount_rub: 900 })], []);
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 3: Запустить и убедиться, что падает**

```bash
cd app && npx jest tests/lib/expensesAggregate.test.ts
```

Ожидается: FAIL — модуль `@/lib/expenses/aggregate` не найден.

- [ ] **Step 4: Реализовать агрегации**

Создать `app/src/lib/expenses/aggregate.ts`:

```ts
import { differenceInCalendarDays, parseISO } from 'date-fns';

import { bucketKey, type GroupBy } from '@/lib/expenses/period';
import {
  TRANSFER_CATEGORIES,
  type ExpenseRow,
  type ExpensesSummary,
  type SeriesPoint,
  type VendorBreakdownItem,
} from '@/lib/expenses/types';

const UNCLASSIFIED_LABEL = 'Без категории';

function isTransfer(r: ExpenseRow): boolean {
  return r.category !== null && TRANSFER_CATEGORIES.includes(r.category);
}

function rub(r: ExpenseRow): number {
  return r.amount_rub ?? 0;
}

function sum(rows: ExpenseRow[]): number {
  return rows.reduce((acc, r) => acc + rub(r), 0);
}

function delta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

/**
 * Итоги и ряд по времени.
 *
 * Перемещения (category=transfer) исключаются из итога и из ряда, но
 * показываются отдельным числом: если их спрятать совсем, сумма перестанет
 * сходиться с банковской выпиской и проверить дашборд будет нечем.
 */
export function summarize(
  rows: ExpenseRow[],
  groupBy: GroupBy,
  range: { from: string; to: string },
  prevRows: ExpenseRow[] | null,
): ExpensesSummary {
  const spend = rows.filter((r) => !isTransfer(r));
  const transfers = rows.filter(isTransfer);

  const total = sum(spend);
  const days = differenceInCalendarDays(parseISO(range.to), parseISO(range.from)) + 1;

  const buckets = new Map<string, SeriesPoint>();
  for (const r of spend) {
    const key = bucketKey(r.occurred_on_msk, groupBy);
    const point = buckets.get(key) ?? { bucket: key, total: 0, byCategory: {}, bySource: {} };
    const value = rub(r);
    const category = r.category ?? 'unclassified';
    point.total += value;
    point.byCategory[category] = (point.byCategory[category] ?? 0) + value;
    point.bySource[r.source] = (point.bySource[r.source] ?? 0) + value;
    buckets.set(key, point);
  }

  const unclassified = spend.filter((r) => r.vendor_id === null);

  return {
    total,
    avgPerDay: days > 0 ? total / days : 0,
    deltaPrev: prevRows === null ? null : delta(total, sum(prevRows.filter((r) => !isTransfer(r)))),
    transfersTotal: sum(transfers),
    unclassifiedCount: unclassified.length,
    unclassifiedTotal: sum(unclassified),
    unconvertedCount: spend.filter((r) => r.amount_rub === null).length,
    series: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

/** Разбивка по вендорам с долей и дельтой к прошлому периоду. */
export function breakdownByVendor(rows: ExpenseRow[], prevRows: ExpenseRow[]): VendorBreakdownItem[] {
  const spend = rows.filter((r) => !isTransfer(r));
  const total = sum(spend);

  const prevByVendor = new Map<string, number>();
  for (const r of prevRows.filter((x) => !isTransfer(x))) {
    const key = r.vendor_id ?? '';
    prevByVendor.set(key, (prevByVendor.get(key) ?? 0) + rub(r));
  }

  const acc = new Map<string, VendorBreakdownItem>();
  for (const r of spend) {
    const key = r.vendor_id ?? '';
    const item = acc.get(key) ?? {
      vendorId: r.vendor_id,
      vendorName: r.vendor_name ?? UNCLASSIFIED_LABEL,
      category: r.category,
      total: 0,
      ops: 0,
      share: 0,
      deltaPrev: null,
    };
    item.total += rub(r);
    item.ops += 1;
    acc.set(key, item);
  }

  return [...acc.entries()]
    .map(([key, item]) => ({
      ...item,
      share: total > 0 ? item.total / total : 0,
      deltaPrev: delta(item.total, prevByVendor.get(key) ?? 0),
    }))
    .sort((a, b) => b.total - a.total);
}
```

- [ ] **Step 5: Запустить тест**

```bash
cd app && npx jest tests/lib/expensesAggregate.test.ts
```

Ожидается: 10 passed.

- [ ] **Step 6: Коммит**

```bash
git add app/src/lib/expenses/types.ts app/src/lib/expenses/aggregate.ts app/tests/lib/expensesAggregate.test.ts
git commit -m "feat(expenses): агрегации итогов и разбивки по вендорам"
```

---

### Task 7: Выборка строк витрины

**Files:**
- Create: `app/src/lib/expenses/rows.ts`

- [ ] **Step 1: Реализовать постраничную выборку**

Создать `app/src/lib/expenses/rows.ts`:

```ts
import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ExpenseRow } from '@/lib/expenses/types';

/**
 * PostgREST по умолчанию отдаёт максимум 1000 строк и делает это МОЛЧА —
 * без пагинации годовой период просто обрезался бы, а дашборд показывал бы
 * заниженную сумму без единой ошибки в логах. Поэтому читаем страницами.
 */
const PAGE_SIZE = 1000;
const MAX_ROWS = 100_000;

export interface RowFilters {
  from: string;
  to: string;
  source?: string | null;
  category?: string | null;
  vendorId?: string | null;
  unclassifiedOnly?: boolean;
}

export async function fetchExpenseRows(filters: RowFilters): Promise<ExpenseRow[]> {
  if (!supabaseAdmin) throw new Error('Server misconfigured: supabaseAdmin недоступен');

  const rows: ExpenseRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    let query = supabaseAdmin
      .from('expenses_v')
      .select(
        'source, source_ref, occurred_on_msk, amount, currency, counterparty, counterparty_inn, details, vendor_id, vendor_name, category, classification_method, amount_rub',
      )
      .gte('occurred_on_msk', filters.from)
      .lte('occurred_on_msk', filters.to)
      .order('occurred_on_msk', { ascending: false })
      .order('source_ref', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (filters.source) query = query.eq('source', filters.source);
    if (filters.category) query = query.eq('category', filters.category);
    if (filters.vendorId) query = query.eq('vendor_id', filters.vendorId);
    if (filters.unclassifiedOnly) query = query.is('vendor_id', null);

    const { data, error } = await query;
    if (error) throw new Error(`expenses_v: ${error.message}`);

    const page = (data ?? []) as ExpenseRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}
```

- [ ] **Step 2: Проверить типы**

```bash
cd app && npx tsc --noEmit
```

Ожидается: без ошибок.

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/expenses/rows.ts
git commit -m "feat(expenses): постраничная выборка витрины"
```

---

### Task 8: Роуты summary, vendors, transactions

**Files:**
- Create: `app/src/app/api/expenses/summary/route.ts`
- Create: `app/src/app/api/expenses/vendors/route.ts`
- Create: `app/src/app/api/expenses/transactions/route.ts`

- [ ] **Step 1: Создать `summary/route.ts`**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { summarize } from '@/lib/expenses/aggregate';
import { parseRange, previousRange, GROUP_BY_VALUES, type GroupBy } from '@/lib/expenses/period';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const params = req.nextUrl.searchParams;
  const groupByParam = (params.get('groupBy') ?? 'day') as GroupBy;
  if (!GROUP_BY_VALUES.includes(groupByParam)) {
    return NextResponse.json({ error: 'groupBy: ожидается day, week или month' }, { status: 400 });
  }

  let range: { from: string; to: string };
  try {
    range = parseRange(params.get('from') ?? '', params.get('to') ?? '');
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const filters = { source: params.get('source'), category: params.get('category') };
  const prev = previousRange(range.from, range.to);

  const [rows, prevRows] = await Promise.all([
    fetchExpenseRows({ ...range, ...filters }),
    fetchExpenseRows({ ...prev, ...filters }),
  ]);

  return NextResponse.json(summarize(rows, groupByParam, range, prevRows));
}
```

- [ ] **Step 2: Создать `vendors/route.ts` (GET-разбивка и POST-создание)**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { breakdownByVendor } from '@/lib/expenses/aggregate';
import { parseRange, previousRange } from '@/lib/expenses/period';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { CATEGORY_LABELS, type ExpenseCategory } from '@/lib/expenses/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const params = req.nextUrl.searchParams;
  let range: { from: string; to: string };
  try {
    range = parseRange(params.get('from') ?? '', params.get('to') ?? '');
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const filters = { source: params.get('source'), category: params.get('category') };
  const prev = previousRange(range.from, range.to);

  const [rows, prevRows] = await Promise.all([
    fetchExpenseRows({ ...range, ...filters }),
    fetchExpenseRows({ ...prev, ...filters }),
  ]);

  return NextResponse.json({ items: breakdownByVendor(rows, prevRows) });
}

export async function POST(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const body = (await req.json()) as { name?: string; category?: string };
  const name = (body.name ?? '').trim();
  const category = body.category as ExpenseCategory | undefined;

  if (name.length < 2) {
    return NextResponse.json({ error: 'Название вендора короче двух символов' }, { status: 400 });
  }
  if (!category || !(category in CATEGORY_LABELS)) {
    return NextResponse.json(
      { error: `Категория должна быть одной из: ${Object.keys(CATEGORY_LABELS).join(', ')}` },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from('expense_vendors')
    .insert({ name, category, created_by: guard.userId })
    .select('id, name, category')
    .single();

  if (error) {
    // Уникальный индекс по lower(name) — вендор с таким именем уже есть.
    const status = error.code === '23505' ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 3: Создать `transactions/route.ts`**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { parseRange } from '@/lib/expenses/period';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const params = req.nextUrl.searchParams;
  let range: { from: string; to: string };
  try {
    range = parseRange(params.get('from') ?? '', params.get('to') ?? '');
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const page = Math.max(0, Number(params.get('page') ?? '0'));
  const rows = await fetchExpenseRows({
    ...range,
    source: params.get('source'),
    category: params.get('category'),
    vendorId: params.get('vendorId'),
  });

  return NextResponse.json({
    items: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    total: rows.length,
    page,
    pageSize: PAGE_SIZE,
  });
}
```

- [ ] **Step 4: Проверить типы и прогнать тесты**

```bash
cd app && npx tsc --noEmit && npx jest tests/lib tests/api/expensesAccess.test.ts
```

Ожидается: tsc без ошибок, все тесты зелёные.

- [ ] **Step 5: Коммит**

```bash
git add app/src/app/api/expenses/summary app/src/app/api/expenses/vendors app/src/app/api/expenses/transactions
git commit -m "feat(expenses): роуты summary, vendors, transactions"
```

---

### Task 9: Очередь разметки и классификация

**Files:**
- Create: `app/src/app/api/expenses/unclassified/route.ts`
- Create: `app/src/app/api/expenses/classify/route.ts`

- [ ] **Step 1: Создать `unclassified/route.ts`**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { parseRange } from '@/lib/expenses/period';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const params = req.nextUrl.searchParams;
  let range: { from: string; to: string };
  try {
    range = parseRange(params.get('from') ?? '', params.get('to') ?? '');
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const rows = await fetchExpenseRows({ ...range, unclassifiedOnly: true });
  // Сначала самое дорогое: разметка десяти крупных операций закрывает больше
  // суммы, чем сотни мелких.
  rows.sort((a, b) => (b.amount_rub ?? 0) - (a.amount_rub ?? 0));

  return NextResponse.json({ items: rows.slice(0, 200), total: rows.length });
}
```

- [ ] **Step 2: Создать `classify/route.ts`**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const MATCH_FIELDS = ['payee_name', 'payee_inn', 'purpose', 'merchant'] as const;
const MATCH_TYPES = ['exact', 'contains'] as const;

interface ClassifyBody {
  source?: string;
  sourceRef?: string;
  vendorId?: string;
  rule?: {
    matchField?: string;
    matchType?: string;
    pattern?: string;
    source?: string | null;
  };
}

export async function POST(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const body = (await req.json()) as ClassifyBody;
  if (!body.source || !body.sourceRef || !body.vendorId) {
    return NextResponse.json({ error: 'Нужны source, sourceRef и vendorId' }, { status: 400 });
  }

  // Разметку пишем ПЕРВОЙ и с method=manual: apply_expense_rules обновляет
  // только строки с method=rule, поэтому дальнейший прогон правила эту
  // операцию уже не тронет.
  const { error: classifyError } = await supabaseAdmin
    .from('expense_classifications')
    .upsert(
      {
        source: body.source,
        source_ref: body.sourceRef,
        vendor_id: body.vendorId,
        method: 'manual',
        rule_id: null,
        classified_by: guard.userId,
        classified_at: new Date().toISOString(),
      },
      { onConflict: 'source,source_ref' },
    );

  if (classifyError) {
    return NextResponse.json({ error: classifyError.message }, { status: 500 });
  }

  if (!body.rule) return NextResponse.json({ ok: true, applied: 0 });

  const { matchField, matchType, pattern } = body.rule;
  if (!matchField || !MATCH_FIELDS.includes(matchField as (typeof MATCH_FIELDS)[number])) {
    return NextResponse.json({ error: `matchField: ожидается ${MATCH_FIELDS.join(', ')}` }, { status: 400 });
  }
  if (!matchType || !MATCH_TYPES.includes(matchType as (typeof MATCH_TYPES)[number])) {
    return NextResponse.json({ error: `matchType: ожидается ${MATCH_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!pattern || pattern.trim().length < 3) {
    return NextResponse.json(
      { error: 'Образец правила короче трёх символов — такое правило совпадёт почти со всем' },
      { status: 400 },
    );
  }

  const { data: rule, error: ruleError } = await supabaseAdmin
    .from('expense_rules')
    .insert({
      vendor_id: body.vendorId,
      match_field: matchField,
      match_type: matchType,
      pattern: pattern.trim(),
      source: body.rule.source ?? null,
      created_by: guard.userId,
    })
    .select('id')
    .single();

  if (ruleError) {
    const status = ruleError.code === '23505' ? 409 : 500;
    return NextResponse.json({ error: ruleError.message }, { status });
  }

  const { data: applied, error: applyError } = await supabaseAdmin.rpc('apply_expense_rules', {
    p_rule_id: rule.id,
  });

  if (applyError) return NextResponse.json({ error: applyError.message }, { status: 500 });

  return NextResponse.json({ ok: true, ruleId: rule.id, applied: applied ?? 0 });
}
```

- [ ] **Step 3: Проверить типы**

```bash
cd app && npx tsc --noEmit
```

Ожидается: без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add app/src/app/api/expenses/unclassified app/src/app/api/expenses/classify
git commit -m "feat(expenses): очередь разметки и классификация с созданием правила"
```

---

### Task 10: Ручные траты

**Files:**
- Create: `app/src/app/api/expenses/manual/route.ts`
- Create: `app/src/app/api/expenses/manual/[id]/route.ts`
- Test: `app/tests/api/expensesManualRoute.test.ts`

- [ ] **Step 1: Написать падающий тест на права**

Создать `app/tests/api/expensesManualRoute.test.ts`:

```ts
/** @jest-environment node */

import { NextRequest } from 'next/server';

const state: {
  guard: { ok: true; userId: string; role: string } | { ok: false; status: number; error: string };
  existing: { created_by: string } | null;
  deleted: boolean;
} = {
  guard: { ok: true, userId: 'u-1', role: 'manager' },
  existing: { created_by: 'u-1' },
  deleted: false,
};

jest.mock('@/lib/expenses/access', () => ({
  requireExpensesAccess: async () => state.guard,
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.existing, error: null }) }) }),
      delete: () => ({
        eq: async () => {
          state.deleted = true;
          return { error: null };
        },
      }),
    }),
  },
}));

import { DELETE } from '@/app/api/expenses/manual/[id]/route';

function req() {
  return new NextRequest('http://localhost/api/expenses/manual/e-1', { method: 'DELETE' });
}
const ctx = { params: Promise.resolve({ id: 'e-1' }) };

beforeEach(() => {
  state.guard = { ok: true, userId: 'u-1', role: 'manager' };
  state.existing = { created_by: 'u-1' };
  state.deleted = false;
});

it('автор может удалить свою запись', async () => {
  const res = await DELETE(req(), ctx);
  expect(res.status).toBe(200);
  expect(state.deleted).toBe(true);
});

it('чужую запись удалить нельзя', async () => {
  state.existing = { created_by: 'someone-else' };
  const res = await DELETE(req(), ctx);
  expect(res.status).toBe(403);
  expect(state.deleted).toBe(false);
});

it('админ может удалить чужую запись', async () => {
  state.guard = { ok: true, userId: 'u-1', role: 'admin' };
  state.existing = { created_by: 'someone-else' };
  const res = await DELETE(req(), ctx);
  expect(res.status).toBe(200);
});

it('несуществующая запись — 404', async () => {
  state.existing = null;
  const res = await DELETE(req(), ctx);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

```bash
cd app && npx jest tests/api/expensesManualRoute.test.ts
```

Ожидается: FAIL — модуль роута не найден.

- [ ] **Step 3: Создать `manual/route.ts`**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { parseRange } from '@/lib/expenses/period';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const params = req.nextUrl.searchParams;
  let range: { from: string; to: string };
  try {
    range = parseRange(params.get('from') ?? '', params.get('to') ?? '');
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('manual_expenses')
    .select('id, occurred_on, amount, currency, payer, comment, created_by, created_at')
    .gte('occurred_on', range.from)
    .lte('occurred_on', range.to)
    .order('occurred_on', { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const body = (await req.json()) as {
    occurredOn?: string;
    amount?: number;
    currency?: string;
    payer?: string;
    comment?: string;
    vendorId?: string | null;
  };

  const occurredOn = body.occurredOn ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    return NextResponse.json({ error: 'Дата в формате ГГГГ-ММ-ДД' }, { status: 400 });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (occurredOn > today) {
    return NextResponse.json({ error: 'Дата траты в будущем' }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'Сумма должна быть больше нуля' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('manual_expenses')
    .insert({
      occurred_on: occurredOn,
      amount,
      currency: (body.currency ?? 'RUB').toUpperCase(),
      payer: body.payer?.trim() || 'ceo_personal_card',
      comment: body.comment?.trim() || null,
      created_by: guard.userId,
    })
    .select('id, occurred_on, amount, currency, payer, comment, created_by, created_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Вендор выбирается прямо в форме, поэтому запись приходит уже размеченной
  // и в очередь разметки не попадает. Если разметка не проставилась, трата
  // всё равно сохранена и просто окажется в очереди — терять её нельзя.
  if (body.vendorId) {
    await supabaseAdmin.from('expense_classifications').upsert(
      {
        source: 'manual',
        source_ref: data.id,
        vendor_id: body.vendorId,
        method: 'manual',
        classified_by: guard.userId,
      },
      { onConflict: 'source,source_ref' },
    );
  }

  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 4: Создать `manual/[id]/route.ts`**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Править и удалять может автор записи либо админ. Ручной ввод без правки
 * превращается в append-only свалку: опечатку в сумме иначе можно починить
 * только SQL-запросом, то есть на практике никогда.
 */
async function loadOwned(id: string, userId: string, role: string | null) {
  if (!supabaseAdmin) return { error: NextResponse.json({ error: 'Server misconfigured' }, { status: 500 }) };

  const { data, error } = await supabaseAdmin
    .from('manual_expenses')
    .select('created_by')
    .eq('id', id)
    .maybeSingle();

  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!data) return { error: NextResponse.json({ error: 'Запись не найдена' }, { status: 404 }) };
  if (data.created_by !== userId && role !== 'admin') {
    return { error: NextResponse.json({ error: 'Можно менять только свои записи' }, { status: 403 }) };
  }
  return { error: null };
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const owned = await loadOwned(id, guard.userId, guard.role);
  if (owned.error) return owned.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const body = (await req.json()) as {
    occurredOn?: string;
    amount?: number;
    currency?: string;
    comment?: string;
  };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.occurredOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.occurredOn)) {
      return NextResponse.json({ error: 'Дата в формате ГГГГ-ММ-ДД' }, { status: 400 });
    }
    patch.occurred_on = body.occurredOn;
  }
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Сумма должна быть больше нуля' }, { status: 400 });
    }
    patch.amount = amount;
  }
  if (body.currency !== undefined) patch.currency = body.currency.toUpperCase();
  if (body.comment !== undefined) patch.comment = body.comment.trim() || null;

  const { error } = await supabaseAdmin.from('manual_expenses').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const owned = await loadOwned(id, guard.userId, guard.role);
  if (owned.error) return owned.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { error } = await supabaseAdmin.from('manual_expenses').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Запустить тест**

```bash
cd app && npx jest tests/api/expensesManualRoute.test.ts
```

Ожидается: 4 passed.

- [ ] **Step 6: Коммит**

```bash
git add app/src/app/api/expenses/manual app/tests/api/expensesManualRoute.test.ts
git commit -m "feat(expenses): ручные траты с правкой и удалением"
```

---

### Task 11: Выгрузка в xlsx

**Files:**
- Create: `app/src/app/api/expenses/export/route.ts`

- [ ] **Step 1: Создать роут**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { parseRange } from '@/lib/expenses/period';
import { CATEGORY_LABELS, type ExpenseCategory } from '@/lib/expenses/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const params = req.nextUrl.searchParams;
  let range: { from: string; to: string };
  try {
    range = parseRange(params.get('from') ?? '', params.get('to') ?? '');
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const rows = await fetchExpenseRows({
    ...range,
    source: params.get('source'),
    category: params.get('category'),
  });

  const sheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Дата: r.occurred_on_msk,
      Источник: r.source,
      Вендор: r.vendor_name ?? 'Без категории',
      Категория: r.category ? CATEGORY_LABELS[r.category as ExpenseCategory] : '',
      Контрагент: r.counterparty ?? '',
      ИНН: r.counterparty_inn ?? '',
      Назначение: r.details ?? '',
      Сумма: r.amount,
      Валюта: r.currency,
      'Сумма, ₽': r.amount_rub ?? '',
    })),
  );

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Расходы');
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="expenses-${range.from}_${range.to}.xlsx"`,
    },
  });
}
```

- [ ] **Step 2: Проверить типы**

```bash
cd app && npx tsc --noEmit
```

Ожидается: без ошибок.

- [ ] **Step 3: Коммит**

```bash
git add app/src/app/api/expenses/export
git commit -m "feat(expenses): выгрузка периода в xlsx"
```

---

## Фаза 3 — Интерфейс

### Task 12: Зависимость recharts и клиентский fetch

**Files:**
- Modify: `app/package.json`
- Create: `app/src/lib/expenses/client.ts`

- [ ] **Step 1: Поставить recharts**

```bash
cd app && npm install recharts@^3.1.0
```

- [ ] **Step 2: Проверить, что сборка не сломалась**

```bash
cd app && npx tsc --noEmit
```

Ожидается: без ошибок.

- [ ] **Step 3: Создать клиентский хелпер**

`app/src/lib/expenses/client.ts`:

```ts
'use client';

import { supabase } from '@/lib/supabaseClient';

/** Запрос к /api/expenses/* с access-токеном текущей сессии. */
export async function expensesFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Сессия не найдена — перезайди в портал');

  const res = await fetch(`/api/expenses${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Ошибка ${res.status}`);
  }
  return (await res.json()) as T;
}

export function formatRub(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value));
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${Math.round(delta * 100)}%`;
}
```

- [ ] **Step 4: Коммит**

```bash
git add app/package.json app/package-lock.json app/src/lib/expenses/client.ts
git commit -m "feat(expenses): recharts и клиентский слой запросов"
```

---

### Task 13: Фильтры и KPI-строка

**Files:**
- Create: `app/src/components/expenses/Filters.tsx`
- Create: `app/src/components/expenses/KpiRow.tsx`

- [ ] **Step 1: Создать `Filters.tsx`**

```tsx
'use client';

import { format, startOfMonth, subDays, subMonths, startOfYear } from 'date-fns';

import type { GroupBy } from '@/lib/expenses/period';
import { CATEGORY_LABELS, type ExpenseCategory } from '@/lib/expenses/types';

export interface FiltersValue {
  from: string;
  to: string;
  groupBy: GroupBy;
  source: string;
  category: string;
}

const d = (value: Date) => format(value, 'yyyy-MM-dd');

export const PRESETS: { id: string; label: string; range: () => { from: string; to: string } }[] = [
  { id: 'this-month', label: 'Этот месяц', range: () => ({ from: d(startOfMonth(new Date())), to: d(new Date()) }) },
  {
    id: 'prev-month',
    label: 'Прошлый месяц',
    range: () => {
      const prev = subMonths(new Date(), 1);
      return { from: d(startOfMonth(prev)), to: d(subDays(startOfMonth(new Date()), 1)) };
    },
  },
  { id: '30d', label: '30 дней', range: () => ({ from: d(subDays(new Date(), 29)), to: d(new Date()) }) },
  { id: 'quarter', label: 'Квартал', range: () => ({ from: d(subDays(new Date(), 89)), to: d(new Date()) }) },
  { id: 'year', label: 'Год', range: () => ({ from: d(startOfYear(new Date())), to: d(new Date()) }) },
];

const SOURCES = [
  { id: '', label: 'Все источники' },
  { id: 'tochka', label: 'Точка' },
  { id: 'tbank', label: 'Т-Банк' },
  { id: 'brocard', label: 'Brocard' },
  { id: 'manual', label: 'Ручные' },
];

export function Filters({
  value,
  onChange,
}: {
  value: FiltersValue;
  onChange: (next: FiltersValue) => void;
}) {
  const set = (patch: Partial<FiltersValue>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => set(preset.range())}
          className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
        >
          {preset.label}
        </button>
      ))}

      <input
        type="date"
        value={value.from}
        max={value.to}
        onChange={(e) => set({ from: e.target.value })}
        className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
        aria-label="Начало периода"
      />
      <input
        type="date"
        value={value.to}
        min={value.from}
        onChange={(e) => set({ to: e.target.value })}
        className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
        aria-label="Конец периода"
      />

      <div className="flex rounded-lg border border-zinc-200 p-0.5">
        {(['day', 'week', 'month'] as GroupBy[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => set({ groupBy: g })}
            className={`rounded-md px-2.5 py-1 text-xs ${
              value.groupBy === g ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-50'
            }`}
          >
            {g === 'day' ? 'День' : g === 'week' ? 'Неделя' : 'Месяц'}
          </button>
        ))}
      </div>

      <select
        value={value.source}
        onChange={(e) => set({ source: e.target.value })}
        className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
        aria-label="Источник"
      >
        {SOURCES.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>

      <select
        value={value.category}
        onChange={(e) => set({ category: e.target.value })}
        className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
        aria-label="Категория"
      >
        <option value="">Все категории</option>
        {(Object.keys(CATEGORY_LABELS) as ExpenseCategory[]).map((c) => (
          <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Создать `KpiRow.tsx`**

```tsx
'use client';

import { formatDelta, formatRub } from '@/lib/expenses/client';
import type { ExpensesSummary } from '@/lib/expenses/types';

function Tile({
  label,
  value,
  hint,
  tone = 'normal',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'normal' | 'warning';
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        tone === 'warning' ? 'border-amber-300 bg-amber-50' : 'border-zinc-200 bg-white'
      }`}
    >
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-zinc-500">{hint}</div> : null}
    </div>
  );
}

export function KpiRow({ summary, onOpenQueue }: { summary: ExpensesSummary; onOpenQueue: () => void }) {
  const needsAttention = summary.unclassifiedCount > 0 || summary.unconvertedCount > 0;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <Tile label="Всего за период" value={`${formatRub(summary.total)} ₽`} />
      <Tile label="В среднем в день" value={`${formatRub(summary.avgPerDay)} ₽`} />
      <Tile label="К прошлому периоду" value={formatDelta(summary.deltaPrev)} />
      <Tile
        label="Перемещения"
        value={`${formatRub(summary.transfersTotal)} ₽`}
        hint="В итог не входят"
      />
      {/* Неразмеченное стоит в одном ряду с итогом намеренно: пока эта цифра
          большая, остальным числам верить нельзя. */}
      <button type="button" onClick={onOpenQueue} className="text-left">
        <Tile
          label="Не размечено"
          value={`${summary.unclassifiedCount} на ${formatRub(summary.unclassifiedTotal)} ₽`}
          hint={summary.unconvertedCount > 0 ? `+${summary.unconvertedCount} без курса валюты` : 'Разметить'}
          tone={needsAttention ? 'warning' : 'normal'}
        />
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Проверить типы**

```bash
cd app && npx tsc --noEmit
```

Ожидается: без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add app/src/components/expenses/Filters.tsx app/src/components/expenses/KpiRow.tsx
git commit -m "feat(expenses): фильтры и KPI-строка"
```

---

### Task 14: График по времени и разбивка по сервисам

**Files:**
- Create: `app/src/components/expenses/TimeChart.tsx`
- Create: `app/src/components/expenses/VendorBreakdown.tsx`

- [ ] **Step 1: Создать `TimeChart.tsx`**

```tsx
'use client';

import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatRub } from '@/lib/expenses/client';
import { CATEGORY_LABELS, type ExpenseCategory } from '@/lib/expenses/types';
import type { SeriesPoint } from '@/lib/expenses/types';

const CATEGORY_COLORS: Record<string, string> = {
  payroll: '#0d6b57',
  marketing: '#2f7fd1',
  tools: '#8a5cd6',
  taxes: '#b4553c',
  operations: '#6b7280',
  other: '#a1a1aa',
  unclassified: '#d4a017',
};

const SOURCE_COLORS: Record<string, string> = {
  tochka: '#0d6b57',
  tbank: '#d4a017',
  brocard: '#8a5cd6',
  manual: '#6b7280',
};

const SOURCE_LABELS: Record<string, string> = {
  tochka: 'Точка',
  tbank: 'Т-Банк',
  brocard: 'Brocard',
  manual: 'Ручные',
};

export function TimeChart({ series }: { series: SeriesPoint[] }) {
  const [stackBy, setStackBy] = useState<'category' | 'source'>('category');

  const { data, keys } = useMemo(() => {
    const seen = new Set<string>();
    const rows = series.map((point) => {
      const parts = stackBy === 'category' ? point.byCategory : point.bySource;
      Object.keys(parts).forEach((k) => seen.add(k));
      return { bucket: point.bucket, ...parts };
    });
    return { data: rows, keys: [...seen].sort() };
  }, [series, stackBy]);

  const label = (key: string) =>
    stackBy === 'category'
      ? key === 'unclassified'
        ? 'Без категории'
        : CATEGORY_LABELS[key as ExpenseCategory] ?? key
      : SOURCE_LABELS[key] ?? key;

  const color = (key: string) =>
    (stackBy === 'category' ? CATEGORY_COLORS[key] : SOURCE_COLORS[key]) ?? '#a1a1aa';

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900">Расходы по времени</h3>
        <div className="flex rounded-lg border border-zinc-200 p-0.5">
          {(['category', 'source'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setStackBy(mode)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                stackBy === mode ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              {mode === 'category' ? 'По категориям' : 'По источникам'}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f0" vertical={false} />
          <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatRub(v)} />
          <Tooltip formatter={(v: number, key: string) => [`${formatRub(v)} ₽`, label(key)]} />
          <Legend formatter={(key: string) => label(key)} />
          {keys.map((key) => (
            <Bar key={key} dataKey={key} stackId="a" fill={color(key)} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Создать `VendorBreakdown.tsx`**

```tsx
'use client';

import { useState } from 'react';

import { expensesFetch, formatDelta, formatRub } from '@/lib/expenses/client';
import { CATEGORY_LABELS, type ExpenseCategory, type ExpenseRow, type VendorBreakdownItem } from '@/lib/expenses/types';

const TOP_N = 15;

export function VendorBreakdown({
  items,
  query,
}: {
  items: VendorBreakdownItem[];
  query: string;
}) {
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const top = items.slice(0, TOP_N);
  const max = top[0]?.total ?? 0;

  async function toggle(item: VendorBreakdownItem) {
    const key = item.vendorId ?? '';
    if (openVendor === key) {
      setOpenVendor(null);
      return;
    }
    setOpenVendor(key);
    setError(null);
    try {
      const res = await expensesFetch<{ items: ExpenseRow[] }>(
        `/transactions?${query}&vendorId=${encodeURIComponent(item.vendorId ?? '')}`,
      );
      setRows(res.items);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-zinc-900">Разбивка по сервисам</h3>

      <div className="space-y-1.5">
        {top.map((item) => (
          <div key={item.vendorId ?? 'none'} className="flex items-center gap-2">
            <span className="w-40 shrink-0 truncate text-xs text-zinc-700">{item.vendorName}</span>
            <span className="h-4 flex-1 rounded bg-zinc-100">
              <span
                className="block h-4 rounded bg-emerald-700"
                style={{ width: max > 0 ? `${(item.total / max) * 100}%` : '0%' }}
              />
            </span>
            <span className="w-28 shrink-0 text-right text-xs tabular-nums text-zinc-900">
              {formatRub(item.total)} ₽
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="py-2">Вендор</th>
              <th className="py-2">Категория</th>
              <th className="py-2 text-right">Сумма</th>
              <th className="py-2 text-right">Доля</th>
              <th className="py-2 text-right">Операций</th>
              <th className="py-2 text-right">Δ</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const key = item.vendorId ?? '';
              return (
                <tr key={key || 'none'} className="border-t border-zinc-100">
                  <td className="py-2">
                    <button type="button" onClick={() => toggle(item)} className="text-left text-emerald-800 hover:underline">
                      {item.vendorName}
                    </button>
                    {openVendor === key ? (
                      <div className="mt-2 space-y-1 border-l-2 border-zinc-200 pl-3">
                        {error ? <div className="text-xs text-red-600">{error}</div> : null}
                        {rows.map((r) => (
                          <div key={`${r.source}:${r.source_ref}`} className="text-[11px] text-zinc-600">
                            <span className="tabular-nums">{r.occurred_on_msk}</span>
                            {' · '}
                            <span>{r.counterparty ?? '—'}</span>
                            {' · '}
                            <span className="tabular-nums">{formatRub(r.amount_rub ?? 0)} ₽</span>
                            {r.details ? <div className="text-zinc-400">{r.details}</div> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 text-zinc-600">
                    {item.category ? CATEGORY_LABELS[item.category as ExpenseCategory] : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatRub(item.total)} ₽</td>
                  <td className="py-2 text-right tabular-nums">{Math.round(item.share * 100)}%</td>
                  <td className="py-2 text-right tabular-nums">{item.ops}</td>
                  <td className="py-2 text-right tabular-nums">{formatDelta(item.deltaPrev)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Проверить типы**

```bash
cd app && npx tsc --noEmit
```

Ожидается: без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add app/src/components/expenses/TimeChart.tsx app/src/components/expenses/VendorBreakdown.tsx
git commit -m "feat(expenses): график по времени и разбивка по сервисам"
```

---

### Task 15: Очередь разметки и форма ручной траты

**Files:**
- Create: `app/src/components/expenses/ClassifyQueue.tsx`
- Create: `app/src/components/expenses/ManualExpenseForm.tsx`

- [ ] **Step 1: Создать `ClassifyQueue.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';

import { expensesFetch, formatRub } from '@/lib/expenses/client';
import { CATEGORY_LABELS, type ExpenseCategory, type ExpenseRow, type VendorBreakdownItem } from '@/lib/expenses/types';

interface Vendor { vendorId: string | null; vendorName: string }

export function ClassifyQueue({
  query,
  vendors,
  onDone,
}: {
  query: string;
  vendors: VendorBreakdownItem[];
  onDone: () => void;
}) {
  const [items, setItems] = useState<ExpenseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const known: Vendor[] = vendors.filter((v) => v.vendorId !== null);

  useEffect(() => {
    expensesFetch<{ items: ExpenseRow[]; total: number }>(`/unclassified?${query}`)
      .then((res) => { setItems(res.items); setTotal(res.total); })
      .catch((e) => setError((e as Error).message));
  }, [query]);

  async function classify(row: ExpenseRow, vendorId: string, remember: boolean) {
    const key = `${row.source}:${row.source_ref}`;
    setBusy(key);
    setError(null);
    try {
      const pattern = row.counterparty_inn ?? row.counterparty ?? '';
      await expensesFetch('/classify', {
        method: 'POST',
        body: JSON.stringify({
          source: row.source,
          sourceRef: row.source_ref,
          vendorId,
          rule: remember && pattern.trim().length >= 3
            ? {
                matchField: row.counterparty_inn ? 'payee_inn' : 'payee_name',
                matchType: row.counterparty_inn ? 'exact' : 'contains',
                pattern,
                source: null,
              }
            : undefined,
        }),
      });
      setItems((prev) => prev.filter((r) => `${r.source}:${r.source_ref}` !== key));
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50/40 p-4">
      <h3 className="mb-1 text-sm font-semibold text-zinc-900">Очередь разметки</h3>
      <p className="mb-3 text-xs text-zinc-600">
        {total} операций без вендора. Сверху самые крупные — они закрывают больше суммы.
      </p>

      {error ? <div className="mb-3 text-xs text-red-600">{error}</div> : null}

      <div className="space-y-2">
        {items.map((row) => (
          <QueueRow
            key={`${row.source}:${row.source_ref}`}
            row={row}
            vendors={known}
            busy={busy === `${row.source}:${row.source_ref}`}
            onClassify={classify}
          />
        ))}
        {items.length === 0 ? <div className="text-xs text-zinc-500">Всё размечено.</div> : null}
      </div>
    </div>
  );
}

function QueueRow({
  row,
  vendors,
  busy,
  onClassify,
}: {
  row: ExpenseRow;
  vendors: Vendor[];
  busy: boolean;
  onClassify: (row: ExpenseRow, vendorId: string, remember: boolean) => void;
}) {
  const [vendorId, setVendorId] = useState('');
  const [remember, setRemember] = useState(true);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-zinc-700">
        <span className="tabular-nums">{row.occurred_on_msk}</span>
        <span className="font-medium">{row.counterparty ?? '—'}</span>
        {row.counterparty_inn ? <span className="text-zinc-400">ИНН {row.counterparty_inn}</span> : null}
        <span className="ml-auto tabular-nums font-semibold">{formatRub(row.amount_rub ?? 0)} ₽</span>
      </div>
      {row.details ? <div className="mt-1 text-[11px] text-zinc-500">{row.details}</div> : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={vendorId}
          onChange={(e) => setVendorId(e.target.value)}
          className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
          aria-label="Вендор"
        >
          <option value="">Выбрать вендора…</option>
          {vendors.map((v) => (
            <option key={v.vendorId ?? ''} value={v.vendorId ?? ''}>{v.vendorName}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-zinc-600">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Запомнить правило
        </label>

        <button
          type="button"
          disabled={!vendorId || busy}
          onClick={() => onClassify(row, vendorId, remember)}
          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {busy ? 'Сохраняю…' : 'Разметить'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Создать `ManualExpenseForm.tsx`**

```tsx
'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { format } from 'date-fns';

import { expensesFetch, formatRub } from '@/lib/expenses/client';
import type { VendorBreakdownItem } from '@/lib/expenses/types';

interface ManualExpense {
  id: string;
  occurred_on: string;
  amount: number;
  currency: string;
  payer: string;
  comment: string | null;
  created_by: string;
}

export function ManualExpenseForm({
  query,
  vendors,
  onChanged,
}: {
  query: string;
  vendors: VendorBreakdownItem[];
  onChanged: () => void;
}) {
  const [items, setItems] = useState<ManualExpense[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [occurredOn, setOccurredOn] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('RUB');
  const [vendorId, setVendorId] = useState('');
  const [comment, setComment] = useState('');

  const reload = () => {
    expensesFetch<{ items: ManualExpense[] }>(`/manual?${query}`)
      .then((res) => setItems(res.items))
      .catch((e) => setError((e as Error).message));
  };

  useEffect(reload, [query]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await expensesFetch('/manual', {
        method: 'POST',
        body: JSON.stringify({
          occurredOn,
          amount: Number(amount),
          currency,
          vendorId: vendorId || null,
          comment,
        }),
      });
      setAmount('');
      setComment('');
      reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await expensesFetch(`/manual/${id}`, { method: 'DELETE' });
      reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="mb-1 text-sm font-semibold text-zinc-900">Ручная трата</h3>
      <p className="mb-3 text-xs text-zinc-500">Личная карта и всё, чего нет в банковских выгрузках.</p>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Дата
          <input
            type="date"
            value={occurredOn}
            max={format(new Date(), 'yyyy-MM-dd')}
            onChange={(e) => setOccurredOn(e.target.value)}
            className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Сумма
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-28 rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Валюта
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
          >
            {['RUB', 'USD', 'EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          Вендор
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
          >
            <option value="">Без вендора (уйдёт в очередь)</option>
            {vendors.filter((v) => v.vendorId).map((v) => (
              <option key={v.vendorId ?? ''} value={v.vendorId ?? ''}>{v.vendorName}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-zinc-500">
          Комментарий
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs"
          />
        </label>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-zinc-900 px-3 py-2 text-xs text-white disabled:opacity-40"
        >
          {saving ? 'Сохраняю…' : 'Добавить'}
        </button>
      </form>

      {error ? <div className="mt-2 text-xs text-red-600">{error}</div> : null}

      <div className="mt-4 space-y-1">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 border-t border-zinc-100 py-1.5 text-xs">
            <span className="tabular-nums text-zinc-600">{item.occurred_on}</span>
            <span className="tabular-nums font-medium">{formatRub(item.amount)} {item.currency}</span>
            <span className="truncate text-zinc-500">{item.comment ?? ''}</span>
            <button
              type="button"
              onClick={() => remove(item.id)}
              className="ml-auto text-zinc-400 hover:text-red-600"
              aria-label="Удалить запись"
            >
              Удалить
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Проверить типы**

```bash
cd app && npx tsc --noEmit
```

Ожидается: без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add app/src/components/expenses/ClassifyQueue.tsx app/src/components/expenses/ManualExpenseForm.tsx
git commit -m "feat(expenses): очередь разметки и форма ручной траты"
```

---

### Task 16: Страница дашборда

**Files:**
- Create: `app/src/app/expenses/page.tsx`

- [ ] **Step 1: Создать страницу**

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, startOfMonth } from 'date-fns';

import { Filters, type FiltersValue } from '@/components/expenses/Filters';
import { KpiRow } from '@/components/expenses/KpiRow';
import { TimeChart } from '@/components/expenses/TimeChart';
import { VendorBreakdown } from '@/components/expenses/VendorBreakdown';
import { ClassifyQueue } from '@/components/expenses/ClassifyQueue';
import { ManualExpenseForm } from '@/components/expenses/ManualExpenseForm';
import { expensesFetch } from '@/lib/expenses/client';
import type { ExpensesSummary, VendorBreakdownItem } from '@/lib/expenses/types';

export default function ExpensesPage() {
  const [filters, setFilters] = useState<FiltersValue>({
    from: format(startOfMonth(new Date()), 'yyyy-MM-dd'),
    to: format(new Date(), 'yyyy-MM-dd'),
    groupBy: 'day',
    source: '',
    category: '',
  });

  const [summary, setSummary] = useState<ExpensesSummary | null>(null);
  const [vendors, setVendors] = useState<VendorBreakdownItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showQueue, setShowQueue] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams({ from: filters.from, to: filters.to, groupBy: filters.groupBy });
    if (filters.source) p.set('source', filters.source);
    if (filters.category) p.set('category', filters.category);
    return p.toString();
  }, [filters]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      expensesFetch<ExpensesSummary>(`/summary?${query}`),
      expensesFetch<{ items: VendorBreakdownItem[] }>(`/vendors?${query}`),
    ])
      .then(([s, v]) => { setSummary(s); setVendors(v.items); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(load, [load]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-zinc-900">Расходы</h1>
        <a
          href={`/api/expenses/export?${query}`}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
        >
          Выгрузить в xlsx
        </a>
      </div>

      <Filters value={filters} onChange={setFilters} />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : null}

      {loading && !summary ? <div className="text-sm text-zinc-500">Загружаю…</div> : null}

      {summary ? (
        <>
          <KpiRow summary={summary} onOpenQueue={() => setShowQueue((v) => !v)} />
          {showQueue ? <ClassifyQueue query={query} vendors={vendors} onDone={load} /> : null}
          <TimeChart series={summary.series} />
          <VendorBreakdown items={vendors} query={query} />
          <ManualExpenseForm query={query} vendors={vendors} onChanged={load} />
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Проверить сборку и линт**

```bash
cd app && npx tsc --noEmit && npm run lint && npm run build
```

Ожидается: без ошибок, в выводе build видно маршрут `/expenses`.

- [ ] **Step 3: Коммит**

```bash
git add app/src/app/expenses/page.tsx
git commit -m "feat(expenses): страница дашборда расходов"
```

---

### Task 17: Переводы интерфейса

**Files:**
- Modify: `app/src/lib/globalTranslations.ts`

- [ ] **Step 1: Добавить пары ru→en**

В `app/src/lib/globalTranslations.ts` в конец массива пар дописать:

```ts
  ['Расходы', 'Expenses'],
  ['Разбивка по сервисам', 'Breakdown by service'],
  ['Расходы по времени', 'Expenses over time'],
  ['По категориям', 'By category'],
  ['По источникам', 'By source'],
  ['Всего за период', 'Total for period'],
  ['В среднем в день', 'Average per day'],
  ['К прошлому периоду', 'vs previous period'],
  ['Перемещения', 'Transfers'],
  ['В итог не входят', 'Excluded from total'],
  ['Не размечено', 'Unclassified'],
  ['Очередь разметки', 'Classification queue'],
  ['Запомнить правило', 'Remember as rule'],
  ['Разметить', 'Classify'],
  ['Ручная трата', 'Manual expense'],
  ['Личная карта и всё, чего нет в банковских выгрузках.', 'Personal card and anything missing from bank feeds.'],
  ['Без вендора (уйдёт в очередь)', 'No vendor (goes to queue)'],
  ['Выгрузить в xlsx', 'Export to xlsx'],
  ['Все источники', 'All sources'],
  ['Все категории', 'All categories'],
  ['Этот месяц', 'This month'],
  ['Прошлый месяц', 'Previous month'],
  ['ФОТ', 'Payroll'],
  ['Маркетинг', 'Marketing'],
  ['Сервисы и подписки', 'Tools & subscriptions'],
  ['Налоги', 'Taxes'],
  ['Операционка', 'Operations'],
  ['Прочее', 'Other'],
  ['Без категории', 'Uncategorized'],
```

- [ ] **Step 2: Проверить типы**

```bash
cd app && npx tsc --noEmit
```

Ожидается: без ошибок.

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/globalTranslations.ts
git commit -m "feat(expenses): переводы интерфейса"
```

---

### Task 18: Приёмка

**Files:** нет — проверка руками.

- [ ] **Step 1: Прогнать весь набор тестов**

```bash
cd app && npx jest tests/lib/expensesPeriod.test.ts tests/lib/expensesAggregate.test.ts tests/lib/expensesNavVisibility.test.ts tests/api/expensesAccess.test.ts tests/api/expensesManualRoute.test.ts
```

Ожидается: все зелёные, ни одного пропущенного.

- [ ] **Step 2: Проверить закрытость данных**

Зайти под пользователем без выданного тумблера и без роли админа:

```bash
curl -i -H "Authorization: Bearer <токен_этого_пользователя>" "http://localhost:3000/api/expenses/summary?from=2026-07-01&to=2026-07-31&groupBy=day"
```

Ожидается: `HTTP/1.1 403`. Пункт «Расходы» в меню при этом отсутствует.

- [ ] **Step 3: Проверить выдачу доступа**

В `/admin/users` открыть модалку этого пользователя, развернуть «Отображение вкладок в Header-е», включить «Расходы», сохранить. Перезайти под ним.

Ожидается: пункт «Расходы» появился, страница открывается, тот же curl отдаёт 200.

- [ ] **Step 4: Сверить дашборд с SQL**

```bash
psql "$SUPABASE_DB_URL" -c "select sum(amount_rub) from public.expenses_v e left join public.expense_vendors v on v.id = e.vendor_id where e.occurred_on_msk between '2026-07-01' and '2026-07-31' and v.category is distinct from 'transfer';"
```

Ожидается: число совпадает с «Всего за период» на дашборде при выбранном июле.

- [ ] **Step 5: Проверить цикл разметки**

Открыть очередь, разметить одну операцию с галкой «запомнить правило». Ожидается: операция исчезла из очереди, счётчик «не размечено» уменьшился, а другие операции того же контрагента тоже пропали из очереди — правило применилось ко всем похожим.

- [ ] **Step 6: Зафиксировать приёмку**

```bash
git add wiki/log.md
git commit -m "chore(expenses): приёмка дашборда расходов"
```

---

## Что осталось за рамками

- **Brocard** — адаптер `sources/brocard.py` поднимает `NotImplementedError` до выдачи ключей. Когда доступы придут: реализовать `run()` с записью в `brocard_transactions`, остальное уже работает.
- **Сверка подотчёта** — никто не проверяет, что каждой ручной трате соответствует ровно одно возмещение с Точки. Забытая трата просто не будет видна.
- **Старая вкладка «Расходы» в `/finance`** — остаётся с localStorage. Решение о её судьбе в спеке помечено как открытый вопрос.
- **Ролевой гейт на `/finance`** — страница по-прежнему видна любому авторизованному сотруднику. Отдельная задача.
