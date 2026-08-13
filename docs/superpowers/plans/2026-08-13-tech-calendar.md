# Календарь технички — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Экран `/tech-calendar` — календарь оплат студийной технички: суммы месяца по ₽ и $ раздельно, статусы «ожидает решения», продление сервиса одной кнопкой и напоминания админам за 3 дня и в день оплаты.

**Architecture:** Своя таблица `tech_subscriptions`, запертая на RLS: весь доступ идёт через серверные ручки `/api/tech-calendar/*` с `requireAdmin`. Вся арифметика (даты циклов, суммы, пороги) живёт в чистых модулях `app/src/lib/techCalendar/*` и покрыта юнит-тестами; UI и ручки — тонкие обёртки. Напоминания подсаживаются в существующий десятиминутный прогон `/api/cron/deadline-notifications` + `deadlineNotificationsLoop` в воркере.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (PostgREST + service role), Tailwind, Jest + `tests/helpers/mockSupabase`.

**Спека:** `docs/superpowers/specs/2026-08-13-tech-calendar-design.md`

---

## Файловая карта

**Создаём:**

| Файл | Ответственность |
| --- | --- |
| `supabase/migrations/20260813_0003_tech_subscriptions.sql` | Таблица подписок, лог напоминаний, расширение CHECK у `notifications` |
| `app/src/lib/techCalendar/types.ts` | Типы, списки значений, подписи |
| `app/src/lib/techCalendar/dates.ts` | Арифметика дат: сдвиг цикла, дни до даты, дата по МСК |
| `app/src/lib/techCalendar/money.ts` | Формат сумм и сложение по валютам |
| `app/src/lib/techCalendar/stats.ts` | Плитки, суммы месяца, разбивка по типам, «ближайшие» |
| `app/src/lib/techCalendar/validate.ts` | Разбор пользовательского ввода из тела запроса |
| `app/src/lib/techCalendar/pending.ts` | Перевод `active` → `pending_review` за 7 дней |
| `app/src/lib/notifications/techRenewalCron.ts` | Напоминания админам за 3 дня и в день оплаты |
| `app/src/app/api/tech-calendar/subscriptions/route.ts` | GET списка, POST создания |
| `app/src/app/api/tech-calendar/subscriptions/[id]/route.ts` | PATCH, DELETE |
| `app/src/app/api/tech-calendar/subscriptions/[id]/renew/route.ts` | POST продления |
| `app/src/app/api/tech-calendar/subscriptions/[id]/decision/route.ts` | POST решения |
| `app/src/app/tech-calendar/page.tsx` | Точка входа страницы |
| `app/src/app/tech-calendar/layout.tsx` | Клиентская проверка роли |
| `app/src/app/tech-calendar/TechCalendarView.tsx` | Состояние, загрузка, склейка частей |
| `app/src/components/tech-calendar/StatsRow.tsx` | Четыре плитки |
| `app/src/components/tech-calendar/TypeBreakdown.tsx` | Фильтр по типу и суммы по типам |
| `app/src/components/tech-calendar/MonthGrid.tsx` | Сетка месяца и попап дня |
| `app/src/components/tech-calendar/UpcomingList.tsx` | «Ближайшие 7 дней» |
| `app/src/components/tech-calendar/SubscriptionModal.tsx` | Создание / правка / продление / решение |
| `app/src/components/tech-calendar/statusStyles.ts` | Цвета статусов, общие для сетки и списков |

**Меняем:**

| Файл | Что |
| --- | --- |
| `app/src/lib/navigation.ts` | Пункт меню «Календарь технички» с `adminOnly: true` |
| `app/src/middleware.ts` | Редирект не-админа с `/tech-calendar` |
| `app/src/app/api/cron/deadline-notifications/route.ts` | Вызов `runTechRenewalNotifications` |
| `app/worker/index.ts` | Тот же вызов в десятиминутном цикле |
| `app/src/app/notifications/page.tsx` | Подпись типа `tech_renewal` и переход в календарь |
| `docs/portal-product-overview.md` | Раздел про новый экран |

**Тесты:**

`app/tests/lib/techCalendar/dates.test.ts`, `stats.test.ts`, `validate.test.ts`, `pending.test.ts`,
`app/tests/lib/notifications/techRenewalCron.test.ts`,
`app/tests/api/techCalendarRoutes.test.ts`.

**Команды.** Все — из каталога `app`:

```bash
cd app && npx jest tests/lib/techCalendar --silent
```

---

### Task 1: Миграция базы

**Files:**
- Create: `supabase/migrations/20260813_0003_tech_subscriptions.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- Календарь технички: план платежей за прокси, серверы, API и софт.
--
-- Экран «Расходы» показывает уже ушедшие деньги; ответа на вопрос «что и когда
-- спишется на следующей неделе» в портале не было — он жил в личных заметках.
-- Календарь почт решает ровно эту задачу для email-подписок, здесь то же самое
-- для студийной технички.
--
-- Таблица заперта намеренно: политик для `authenticated` нет, читать и писать
-- можно только через серверные ручки /api/tech-calendar/*, каждая начинается с
-- requireAdmin. Суммы по инфраструктуре — не то, что должен видеть клиент или
-- подрядчик, залезая в базу в обход интерфейса.

create table if not exists public.tech_subscriptions (
  id uuid primary key default gen_random_uuid(),

  service_name text not null,
  service_type text not null default 'other'
    check (service_type in ('proxy', 'server', 'api', 'software', 'other')),

  amount numeric(12, 2) not null default 0,
  -- Валюты ровно две. Свободная строка молча роняла бы строку из итога:
  -- суммы считаются по каждой валюте отдельно, и опечатка «USDT» дала бы
  -- сервис, которого нет ни в одном из двух итогов.
  currency text not null default 'RUB'
    check (currency in ('RUB', 'USD')),
  billing_cycle text not null default 'monthly'
    check (billing_cycle in ('monthly', 'quarterly', 'yearly')),
  next_billing_date date not null,

  -- Статуса `expired` нет намеренно: в email_subscriptions он остался от
  -- прежней логики и не выставляется ничем.
  status text not null default 'active'
    check (status in ('active', 'pending_review', 'keep', 'cancel')),

  decision_by uuid references public.profiles(id) on delete set null,
  decision_at timestamptz,
  decision_notes text,

  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tech_subscriptions_billing_date
  on public.tech_subscriptions(next_billing_date);
create index if not exists idx_tech_subscriptions_status
  on public.tech_subscriptions(status);
create index if not exists idx_tech_subscriptions_type
  on public.tech_subscriptions(service_type);

alter table public.tech_subscriptions enable row level security;

grant all on public.tech_subscriptions to service_role;

create or replace function public.tech_subscriptions_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tech_subscriptions_updated_at on public.tech_subscriptions;
create trigger tech_subscriptions_updated_at
  before update on public.tech_subscriptions
  for each row execute function public.tech_subscriptions_touch_updated_at();

-- Лог напоминаний. Ключ включает дату списания: после продления дата уезжает,
-- и следующий цикл напоминает заново сам, а прогон раз в 10 минут при этом не
-- превращается в спам.
create table if not exists public.tech_renewal_notification_log (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.tech_subscriptions(id) on delete cascade,
  billing_date date not null,
  level text not null check (level in ('soon', 'due')),
  created_at timestamptz not null default now(),
  unique (subscription_id, billing_date, level)
);

alter table public.tech_renewal_notification_log enable row level security;

grant all on public.tech_renewal_notification_log to service_role;

-- Новый тип уведомления и новый вид сущности, на которую оно ссылается.
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('deadline', 'deadline_lead', 'deadline_ceo',
                  'lead_new', 'lead_escalation', 'lead_ceo',
                  'info', 'tech_renewal'));

alter table public.notifications
  drop constraint if exists notifications_entity_type_check;
alter table public.notifications
  add constraint notifications_entity_type_check
  check (entity_type is null or entity_type in ('project', 'task', 'lead_qualification', 'tech_subscription'));
```

- [ ] **Step 2: Проверить линт грантов**

Run: `cd app && npx jest tests/migrations --silent`
Expected: PASS (новые таблицы имеют `grant all ... to service_role`).

- [ ] **Step 3: Коммит**

```bash
git add supabase/migrations/20260813_0003_tech_subscriptions.sql
git commit -m "feat(tech-calendar): таблица подписок и лог напоминаний"
```

---

### Task 2: Типы и справочники

**Files:**
- Create: `app/src/lib/techCalendar/types.ts`

- [ ] **Step 1: Написать модуль**

```ts
/**
 * Словарь календаря технички: значения полей и подписи к ним.
 *
 * Списки объявлены через `as const` и типы выведены из них, чтобы новый тип
 * сервиса нельзя было добавить в одном месте и забыть в другом: пропущенный
 * ключ в `SERVICE_TYPE_LABELS` — ошибка компиляции, а не пустая подпись в
 * интерфейсе.
 */

export const SERVICE_TYPES = ['proxy', 'server', 'api', 'software', 'other'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  proxy: 'Прокси',
  server: 'Серверы',
  api: 'API',
  software: 'Софт',
  other: 'Прочее',
};

export const CURRENCIES = ['RUB', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const CYCLE_LABELS: Record<BillingCycle, string> = {
  monthly: 'Ежемесячно',
  quarterly: 'Ежеквартально',
  yearly: 'Ежегодно',
};

export const TECH_STATUSES = ['active', 'pending_review', 'keep', 'cancel'] as const;
export type TechStatus = (typeof TECH_STATUSES)[number];

export const STATUS_LABELS: Record<TechStatus, string> = {
  active: 'Активна',
  pending_review: 'Ожидает решения',
  keep: 'Оставить',
  cancel: 'Отменить',
};

export interface TechSubscription {
  id: string;
  service_name: string;
  service_type: ServiceType;
  amount: number;
  currency: Currency;
  billing_cycle: BillingCycle;
  next_billing_date: string;
  status: TechStatus;
  decision_by: string | null;
  decision_at: string | null;
  decision_notes: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Порог жёлтого статуса в календаре. Напоминания приходят позже — см. techRenewalCron. */
export const PENDING_REVIEW_DAYS = 7;
```

- [ ] **Step 2: Коммит**

```bash
git add app/src/lib/techCalendar/types.ts
git commit -m "feat(tech-calendar): типы и справочники"
```

---

### Task 3: Арифметика дат

**Files:**
- Create: `app/src/lib/techCalendar/dates.ts`
- Test: `app/tests/lib/techCalendar/dates.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

/**
 * Даты календаря технички считаются по компонентам (год-месяц-день), а не
 * через `new Date(строка)`: разбор строки даёт полночь UTC, и на сервере в
 * другом часовом поясе «31 января» превращается в 30-е. В календаре почт это
 * место написано именно так — здесь оно не повторяется, и тест это пинует.
 */

import { addCycle, daysUntil, mskDateStr, getDaysInMonth, getFirstDayOfMonth } from '@/lib/techCalendar/dates';

describe('addCycle', () => {
  it('двигает месячный цикл на месяц', () => {
    expect(addCycle('2026-08-13', 'monthly')).toBe('2026-09-13');
  });

  it('переносит через год', () => {
    expect(addCycle('2026-12-20', 'monthly')).toBe('2027-01-20');
  });

  it('прижимает 31 января к концу февраля', () => {
    expect(addCycle('2026-01-31', 'monthly')).toBe('2026-02-28');
  });

  it('учитывает високосный год', () => {
    expect(addCycle('2028-01-31', 'monthly')).toBe('2028-02-29');
  });

  it('двигает 29 февраля високосного года на 28-е следующего', () => {
    expect(addCycle('2028-02-29', 'yearly')).toBe('2029-02-28');
  });

  it('двигает квартальный цикл на три месяца', () => {
    expect(addCycle('2026-08-31', 'quarterly')).toBe('2026-11-30');
  });

  it('двигает годовой цикл на год', () => {
    expect(addCycle('2026-08-13', 'yearly')).toBe('2027-08-13');
  });
});

describe('daysUntil', () => {
  it('считает сегодня нулём', () => {
    expect(daysUntil('2026-08-13', '2026-08-13')).toBe(0);
  });

  it('считает завтра единицей', () => {
    expect(daysUntil('2026-08-14', '2026-08-13')).toBe(1);
  });

  it('отдаёт отрицательное для просрочки', () => {
    expect(daysUntil('2026-08-10', '2026-08-13')).toBe(-3);
  });

  it('считает через границу месяца', () => {
    expect(daysUntil('2026-09-02', '2026-08-31')).toBe(2);
  });
});

describe('mskDateStr', () => {
  it('берёт московскую дату, а не UTC-шную', () => {
    // 22:30 UTC 12 августа = 01:30 МСК 13 августа.
    expect(mskDateStr(new Date('2026-08-12T22:30:00Z'))).toBe('2026-08-13');
  });

  it('не сдвигает дату днём', () => {
    expect(mskDateStr(new Date('2026-08-13T09:00:00Z'))).toBe('2026-08-13');
  });
});

describe('сетка месяца', () => {
  it('знает длину месяца', () => {
    expect(getDaysInMonth(2026, 1)).toBe(28);
    expect(getDaysInMonth(2028, 1)).toBe(29);
    expect(getDaysInMonth(2026, 7)).toBe(31);
  });

  it('считает понедельник нулевым днём недели', () => {
    // 1 августа 2026 — суббота.
    expect(getFirstDayOfMonth(2026, 7)).toBe(5);
    // 1 июня 2026 — понедельник.
    expect(getFirstDayOfMonth(2026, 5)).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `cd app && npx jest tests/lib/techCalendar/dates.test.ts --silent`
Expected: FAIL — `Cannot find module '@/lib/techCalendar/dates'`.

- [ ] **Step 3: Написать модуль**

```ts
/**
 * Арифметика дат календаря технички.
 *
 * Все функции работают со строками `YYYY-MM-DD` и считают по компонентам даты.
 * `new Date('2026-01-31')` — это полночь UTC, и на сервере в другом поясе
 * такая дата уезжает на сутки назад; в календаре платежей это ошибка на день
 * в обе стороны, а не косметика.
 */
import type { BillingCycle } from '@/lib/techCalendar/types';

const MSK_OFFSET_MINUTES = 3 * 60;

const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

interface DateParts {
  year: number;
  month: number; // 0-based
  day: number;
}

export function parseDateStr(dateStr: string): DateParts {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

export function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** День недели первого числа месяца, где понедельник = 0. */
export function getFirstDayOfMonth(year: number, month: number): number {
  const day = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return day === 0 ? 6 : day - 1;
}

/**
 * Сдвиг на один цикл. Если в целевом месяце нет такого числа — берётся
 * последний день месяца: 31 января + месяц = 28 или 29 февраля.
 */
export function addCycle(dateStr: string, cycle: BillingCycle): string {
  const { year, month, day } = parseDateStr(dateStr);
  const shifted = month + CYCLE_MONTHS[cycle];
  const targetYear = year + Math.floor(shifted / 12);
  const targetMonth = ((shifted % 12) + 12) % 12;
  const maxDay = getDaysInMonth(targetYear, targetMonth);
  return toDateStr(targetYear, targetMonth, Math.min(day, maxDay));
}

/** Сколько целых дней от `todayStr` до `dateStr`. Прошлое — отрицательное. */
export function daysUntil(dateStr: string, todayStr: string): number {
  const a = parseDateStr(todayStr);
  const b = parseDateStr(dateStr);
  const aMs = Date.UTC(a.year, a.month, a.day);
  const bMs = Date.UTC(b.year, b.month, b.day);
  return Math.round((bMs - aMs) / 86_400_000);
}

/** Московская дата момента. Сервер живёт в UTC, а рабочий день — в МСК. */
export function mskDateStr(now: Date): string {
  const msk = new Date(now.getTime() + MSK_OFFSET_MINUTES * 60_000);
  return toDateStr(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
}

/** Сдвиг даты на N дней — для порогов «через 3 дня», «через неделю». */
export function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDateStr(dateStr);
  const shifted = new Date(Date.UTC(year, month, day + days));
  return toDateStr(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}
```

- [ ] **Step 4: Запустить тест и убедиться, что проходит**

Run: `cd app && npx jest tests/lib/techCalendar/dates.test.ts --silent`
Expected: PASS, 13 тестов.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/techCalendar/dates.ts app/tests/lib/techCalendar/dates.test.ts
git commit -m "feat(tech-calendar): арифметика дат циклов"
```

---

### Task 4: Суммы и плитки

**Files:**
- Create: `app/src/lib/techCalendar/money.ts`, `app/src/lib/techCalendar/stats.ts`
- Test: `app/tests/lib/techCalendar/stats.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

/**
 * Плитки и суммы календаря технички.
 *
 * Главное, что тут пинуется: рубли и доллары не смешиваются ни в итоге месяца,
 * ни в разбивке по типам, а отменённые сервисы не попадают ни в деньги, ни в
 * счётчик активных — иначе экран показывал бы расход, которого не будет.
 */

import {
  activeCount,
  decisionsDueWithin,
  monthTotals,
  pendingCount,
  totalsByType,
  upcoming,
} from '@/lib/techCalendar/stats';
import type { TechSubscription } from '@/lib/techCalendar/types';

function sub(over: Partial<TechSubscription>): TechSubscription {
  return {
    id: 'id-1',
    service_name: 'Сервис',
    service_type: 'proxy',
    amount: 100,
    currency: 'RUB',
    billing_cycle: 'monthly',
    next_billing_date: '2026-08-20',
    status: 'active',
    decision_by: null,
    decision_at: null,
    decision_notes: null,
    notes: null,
    created_by: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('monthTotals', () => {
  it('складывает рубли и доллары раздельно', () => {
    const subs = [
      sub({ id: 'a', amount: 15000, currency: 'RUB' }),
      sub({ id: 'b', amount: 250, currency: 'USD' }),
      sub({ id: 'c', amount: 3000, currency: 'RUB' }),
    ];
    expect(monthTotals(subs, 2026, 7)).toEqual({ RUB: 18000, USD: 250 });
  });

  it('не берёт чужие месяцы', () => {
    const subs = [
      sub({ id: 'a', amount: 100, next_billing_date: '2026-08-31' }),
      sub({ id: 'b', amount: 500, next_billing_date: '2026-09-01' }),
    ];
    expect(monthTotals(subs, 2026, 7)).toEqual({ RUB: 100, USD: 0 });
  });

  it('не считает отменённые', () => {
    const subs = [
      sub({ id: 'a', amount: 100 }),
      sub({ id: 'b', amount: 900, status: 'cancel' }),
    ];
    expect(monthTotals(subs, 2026, 7)).toEqual({ RUB: 100, USD: 0 });
  });
});

describe('totalsByType', () => {
  it('разносит суммы по типам и валютам', () => {
    const subs = [
      sub({ id: 'a', service_type: 'proxy', amount: 5000, currency: 'RUB' }),
      sub({ id: 'b', service_type: 'proxy', amount: 40, currency: 'USD' }),
      sub({ id: 'c', service_type: 'server', amount: 12000, currency: 'RUB' }),
    ];
    const result = totalsByType(subs, 2026, 7);
    expect(result.proxy).toEqual({ RUB: 5000, USD: 40 });
    expect(result.server).toEqual({ RUB: 12000, USD: 0 });
    expect(result.api).toEqual({ RUB: 0, USD: 0 });
  });
});

describe('счётчики', () => {
  const subs = [
    sub({ id: 'a', status: 'active' }),
    sub({ id: 'b', status: 'pending_review' }),
    sub({ id: 'c', status: 'keep' }),
    sub({ id: 'd', status: 'cancel' }),
  ];

  it('считает активными всё, кроме отменённых', () => {
    expect(activeCount(subs)).toBe(3);
  });

  it('считает ожидающие решения', () => {
    expect(pendingCount(subs)).toBe(1);
  });
});

describe('decisionsDueWithin', () => {
  const today = '2026-08-13';

  it('берёт сервисы в пределах недели без решения', () => {
    const subs = [
      sub({ id: 'a', next_billing_date: '2026-08-14', status: 'pending_review' }),
      sub({ id: 'b', next_billing_date: '2026-08-20', status: 'pending_review' }),
      sub({ id: 'c', next_billing_date: '2026-08-21', status: 'active' }),
    ];
    expect(decisionsDueWithin(subs, today, 7)).toBe(2);
  });

  it('не считает уже решённые и отменённые', () => {
    const subs = [
      sub({ id: 'a', next_billing_date: '2026-08-15', status: 'keep' }),
      sub({ id: 'b', next_billing_date: '2026-08-15', status: 'cancel' }),
      sub({ id: 'c', next_billing_date: '2026-08-15', status: 'pending_review' }),
    ];
    expect(decisionsDueWithin(subs, today, 7)).toBe(1);
  });

  it('считает просроченные — решение по ним всё ещё нужно', () => {
    const subs = [sub({ id: 'a', next_billing_date: '2026-08-11', status: 'pending_review' })];
    expect(decisionsDueWithin(subs, today, 7)).toBe(1);
  });
});

describe('upcoming', () => {
  const today = '2026-08-13';

  it('сортирует по дате и берёт неделю вперёд и три дня назад', () => {
    const subs = [
      sub({ id: 'far', next_billing_date: '2026-08-25' }),
      sub({ id: 'soon', next_billing_date: '2026-08-16' }),
      sub({ id: 'late', next_billing_date: '2026-08-11' }),
      sub({ id: 'old', next_billing_date: '2026-08-01' }),
    ];
    expect(upcoming(subs, today).map((s) => s.id)).toEqual(['late', 'soon']);
  });

  it('не показывает отменённые', () => {
    const subs = [sub({ id: 'a', next_billing_date: '2026-08-14', status: 'cancel' })];
    expect(upcoming(subs, today)).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `cd app && npx jest tests/lib/techCalendar/stats.test.ts --silent`
Expected: FAIL — `Cannot find module '@/lib/techCalendar/stats'`.

- [ ] **Step 3: Написать `money.ts`**

```ts
/**
 * Деньги календаря технички.
 *
 * Итог всегда пара «рубли и доллары», а не одно число: курса в базе нет, и
 * сложение валют по выдуманному курсу соврало бы в цифре, по которой
 * планируют расходы.
 */
import type { Currency } from '@/lib/techCalendar/types';

export interface MoneyTotals {
  RUB: number;
  USD: number;
}

export function emptyTotals(): MoneyTotals {
  return { RUB: 0, USD: 0 };
}

export function addMoney(totals: MoneyTotals, currency: Currency, amount: number): MoneyTotals {
  return { ...totals, [currency]: totals[currency] + amount };
}

const SYMBOLS: Record<Currency, string> = { RUB: '₽', USD: '$' };

export function formatMoney(amount: number, currency: Currency): string {
  const value = amount.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return currency === 'RUB' ? `${value} ${SYMBOLS.RUB}` : `${SYMBOLS.USD}${value}`;
}

/** Итог для плитки: «45 000 ₽» и «$300» двумя строками; нули не печатаем. */
export function formatTotals(totals: MoneyTotals): string[] {
  const lines: string[] = [];
  if (totals.RUB) lines.push(formatMoney(totals.RUB, 'RUB'));
  if (totals.USD) lines.push(formatMoney(totals.USD, 'USD'));
  return lines.length ? lines : [formatMoney(0, 'RUB')];
}
```

- [ ] **Step 4: Написать `stats.ts`**

```ts
/**
 * Счётчики и суммы для плиток календаря технички.
 *
 * Отменённые сервисы (`cancel`) не входят ни в деньги, ни в активные: решение
 * по ним принято, платить их не собираются. В календаре они при этом остаются
 * красными — чтобы техник дошёл и отключил.
 */
import { daysUntil } from '@/lib/techCalendar/dates';
import { addMoney, emptyTotals, type MoneyTotals } from '@/lib/techCalendar/money';
import {
  PENDING_REVIEW_DAYS,
  SERVICE_TYPES,
  type ServiceType,
  type TechSubscription,
} from '@/lib/techCalendar/types';

const UPCOMING_AHEAD_DAYS = 7;
const UPCOMING_BEHIND_DAYS = 3;

function isPayable(sub: TechSubscription): boolean {
  return sub.status !== 'cancel';
}

function inMonth(sub: TechSubscription, year: number, month: number): boolean {
  const [y, m] = sub.next_billing_date.split('-').map(Number);
  return y === year && m - 1 === month;
}

export function monthTotals(subs: TechSubscription[], year: number, month: number): MoneyTotals {
  return subs
    .filter((s) => isPayable(s) && inMonth(s, year, month))
    .reduce((acc, s) => addMoney(acc, s.currency, s.amount), emptyTotals());
}

export function totalsByType(
  subs: TechSubscription[],
  year: number,
  month: number,
): Record<ServiceType, MoneyTotals> {
  const result = Object.fromEntries(
    SERVICE_TYPES.map((t) => [t, emptyTotals()]),
  ) as Record<ServiceType, MoneyTotals>;

  for (const s of subs) {
    if (!isPayable(s) || !inMonth(s, year, month)) continue;
    result[s.service_type] = addMoney(result[s.service_type], s.currency, s.amount);
  }
  return result;
}

export function activeCount(subs: TechSubscription[]): number {
  return subs.filter(isPayable).length;
}

export function pendingCount(subs: TechSubscription[]): number {
  return subs.filter((s) => s.status === 'pending_review').length;
}

/** Сколько решений ждёт ответа в ближайшие `days` дней. Просрочка тоже ждёт. */
export function decisionsDueWithin(
  subs: TechSubscription[],
  todayStr: string,
  days: number = PENDING_REVIEW_DAYS,
): number {
  return subs.filter((s) => {
    if (s.status !== 'active' && s.status !== 'pending_review') return false;
    return daysUntil(s.next_billing_date, todayStr) <= days;
  }).length;
}

/** Список «ближайшие 7 дней»: неделя вперёд плюс три дня просрочки. */
export function upcoming(subs: TechSubscription[], todayStr: string): TechSubscription[] {
  return subs
    .filter((s) => {
      if (!isPayable(s)) return false;
      const d = daysUntil(s.next_billing_date, todayStr);
      return d >= -UPCOMING_BEHIND_DAYS && d <= UPCOMING_AHEAD_DAYS;
    })
    .sort((a, b) => a.next_billing_date.localeCompare(b.next_billing_date));
}
```

- [ ] **Step 5: Запустить тест и убедиться, что проходит**

Run: `cd app && npx jest tests/lib/techCalendar/stats.test.ts --silent`
Expected: PASS, 11 тестов.

- [ ] **Step 6: Коммит**

```bash
git add app/src/lib/techCalendar/money.ts app/src/lib/techCalendar/stats.ts app/tests/lib/techCalendar/stats.test.ts
git commit -m "feat(tech-calendar): суммы месяца по валютам и счётчики плиток"
```

---

### Task 5: Разбор пользовательского ввода

**Files:**
- Create: `app/src/lib/techCalendar/validate.ts`
- Test: `app/tests/lib/techCalendar/validate.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

/**
 * Разбор тела запроса к ручкам календаря технички.
 *
 * Всё, что бросает `ValidationError`, ручка обязана отдавать как 400: битый
 * ввод — это ответ пользователю, а не пятисотка. Тест держит границу: сюда
 * приходят любые данные из браузера, и ни одно поле не должно доехать до
 * запроса в базу непроверенным.
 */

import { ValidationError, parseCreateInput, parsePatchInput, parseRenewInput, parseDecisionInput } from '@/lib/techCalendar/validate';

describe('parseCreateInput', () => {
  it('принимает полную карточку', () => {
    expect(
      parseCreateInput({
        service_name: '  Bright Data ',
        service_type: 'proxy',
        amount: 250,
        currency: 'USD',
        billing_cycle: 'monthly',
        next_billing_date: '2026-08-20',
        notes: 'резидентские',
      }),
    ).toEqual({
      service_name: 'Bright Data',
      service_type: 'proxy',
      amount: 250,
      currency: 'USD',
      billing_cycle: 'monthly',
      next_billing_date: '2026-08-20',
      notes: 'резидентские',
    });
  });

  it('требует название', () => {
    expect(() => parseCreateInput({ service_name: '   ', next_billing_date: '2026-08-20' }))
      .toThrow(ValidationError);
  });

  it('отвергает неизвестный тип сервиса', () => {
    expect(() =>
      parseCreateInput({ service_name: 'X', service_type: 'vpn', next_billing_date: '2026-08-20' }),
    ).toThrow('Неизвестный тип сервиса');
  });

  it('отвергает третью валюту', () => {
    expect(() =>
      parseCreateInput({ service_name: 'X', currency: 'EUR', next_billing_date: '2026-08-20' }),
    ).toThrow('Валюта может быть только RUB или USD');
  });

  it('отвергает битую дату', () => {
    expect(() => parseCreateInput({ service_name: 'X', next_billing_date: '20.08.2026' }))
      .toThrow('Дата в формате ГГГГ-ММ-ДД');
  });

  it('отвергает несуществующую дату', () => {
    expect(() => parseCreateInput({ service_name: 'X', next_billing_date: '2026-02-31' }))
      .toThrow('Такой даты не существует');
  });

  it('отвергает отрицательную сумму', () => {
    expect(() =>
      parseCreateInput({ service_name: 'X', amount: -5, next_billing_date: '2026-08-20' }),
    ).toThrow('Сумма не может быть отрицательной');
  });

  it('подставляет значения по умолчанию', () => {
    expect(parseCreateInput({ service_name: 'X', next_billing_date: '2026-08-20' })).toEqual({
      service_name: 'X',
      service_type: 'other',
      amount: 0,
      currency: 'RUB',
      billing_cycle: 'monthly',
      next_billing_date: '2026-08-20',
      notes: null,
    });
  });
});

describe('parsePatchInput', () => {
  it('берёт только переданные поля', () => {
    expect(parsePatchInput({ amount: 300 })).toEqual({ amount: 300 });
  });

  it('отвергает пустое тело', () => {
    expect(() => parsePatchInput({})).toThrow('Нечего менять');
  });

  it('проверяет переданные поля так же строго', () => {
    expect(() => parsePatchInput({ currency: 'EUR' })).toThrow(ValidationError);
  });
});

describe('parseRenewInput', () => {
  it('разрешает пустое тело — дата считается по циклу', () => {
    expect(parseRenewInput({})).toEqual({});
  });

  it('принимает ручную дату и сумму', () => {
    expect(parseRenewInput({ next_billing_date: '2026-09-25', amount: 275 })).toEqual({
      next_billing_date: '2026-09-25',
      amount: 275,
    });
  });

  it('проверяет дату', () => {
    expect(() => parseRenewInput({ next_billing_date: 'завтра' })).toThrow(ValidationError);
  });
});

describe('parseDecisionInput', () => {
  it('принимает решение с комментарием', () => {
    expect(parseDecisionInput({ decision: 'cancel', notes: 'дорого' })).toEqual({
      decision: 'cancel',
      notes: 'дорого',
    });
  });

  it('отвергает решение вне списка', () => {
    expect(() => parseDecisionInput({ decision: 'maybe' })).toThrow('Решение может быть keep или cancel');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `cd app && npx jest tests/lib/techCalendar/validate.test.ts --silent`
Expected: FAIL — `Cannot find module '@/lib/techCalendar/validate'`.

- [ ] **Step 3: Написать модуль**

```ts
/**
 * Разбор пользовательского ввода для ручек календаря технички.
 *
 * Проверки собраны в одном месте: иначе очередная ручка забудет одну из них и
 * ответит пятисоткой на `amount: "абв"`. Всё, что здесь бросает
 * `ValidationError`, ручка отдаёт как 400.
 */
import {
  BILLING_CYCLES,
  CURRENCIES,
  SERVICE_TYPES,
  type BillingCycle,
  type Currency,
  type ServiceType,
} from '@/lib/techCalendar/types';

export class ValidationError extends Error {}

type Body = Record<string, unknown>;

function fail(message: string): never {
  throw new ValidationError(message);
}

function parseName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('Название сервиса обязательно');
  return (value as string).trim();
}

function parseType(value: unknown): ServiceType {
  if (!SERVICE_TYPES.includes(value as ServiceType)) fail('Неизвестный тип сервиса');
  return value as ServiceType;
}

function parseCurrency(value: unknown): Currency {
  if (!CURRENCIES.includes(value as Currency)) fail('Валюта может быть только RUB или USD');
  return value as Currency;
}

function parseCycle(value: unknown): BillingCycle {
  if (!BILLING_CYCLES.includes(value as BillingCycle)) fail('Неизвестный цикл оплаты');
  return value as BillingCycle;
}

function parseAmount(value: unknown): number {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) fail('Сумма должна быть числом');
  if ((num as number) < 0) fail('Сумма не может быть отрицательной');
  return Math.round((num as number) * 100) / 100;
}

function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Дата в формате ГГГГ-ММ-ДД');
  const [y, m, d] = (value as string).split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    fail('Такой даты не существует');
  }
  return value as string;
}

function parseNotes(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail('Заметка должна быть текстом');
  return (value as string).trim() || null;
}

export interface CreateInput {
  service_name: string;
  service_type: ServiceType;
  amount: number;
  currency: Currency;
  billing_cycle: BillingCycle;
  next_billing_date: string;
  notes: string | null;
}

export function parseCreateInput(body: Body): CreateInput {
  return {
    service_name: parseName(body.service_name),
    service_type: body.service_type === undefined ? 'other' : parseType(body.service_type),
    amount: body.amount === undefined ? 0 : parseAmount(body.amount),
    currency: body.currency === undefined ? 'RUB' : parseCurrency(body.currency),
    billing_cycle: body.billing_cycle === undefined ? 'monthly' : parseCycle(body.billing_cycle),
    next_billing_date: parseDate(body.next_billing_date),
    notes: parseNotes(body.notes),
  };
}

export type PatchInput = Partial<CreateInput>;

export function parsePatchInput(body: Body): PatchInput {
  const patch: PatchInput = {};
  if (body.service_name !== undefined) patch.service_name = parseName(body.service_name);
  if (body.service_type !== undefined) patch.service_type = parseType(body.service_type);
  if (body.amount !== undefined) patch.amount = parseAmount(body.amount);
  if (body.currency !== undefined) patch.currency = parseCurrency(body.currency);
  if (body.billing_cycle !== undefined) patch.billing_cycle = parseCycle(body.billing_cycle);
  if (body.next_billing_date !== undefined) patch.next_billing_date = parseDate(body.next_billing_date);
  if (body.notes !== undefined) patch.notes = parseNotes(body.notes);
  if (!Object.keys(patch).length) fail('Нечего менять');
  return patch;
}

export interface RenewInput {
  next_billing_date?: string;
  amount?: number;
}

export function parseRenewInput(body: Body): RenewInput {
  const input: RenewInput = {};
  if (body.next_billing_date !== undefined) input.next_billing_date = parseDate(body.next_billing_date);
  if (body.amount !== undefined) input.amount = parseAmount(body.amount);
  return input;
}

export interface DecisionInput {
  decision: 'keep' | 'cancel';
  notes: string | null;
}

export function parseDecisionInput(body: Body): DecisionInput {
  if (body.decision !== 'keep' && body.decision !== 'cancel') fail('Решение может быть keep или cancel');
  return { decision: body.decision as 'keep' | 'cancel', notes: parseNotes(body.notes) };
}
```

- [ ] **Step 4: Запустить тест и убедиться, что проходит**

Run: `cd app && npx jest tests/lib/techCalendar/validate.test.ts --silent`
Expected: PASS, 15 тестов.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/techCalendar/validate.ts app/tests/lib/techCalendar/validate.test.ts
git commit -m "feat(tech-calendar): разбор пользовательского ввода"
```

---

### Task 6: Перевод в «ожидает решения»

**Files:**
- Create: `app/src/lib/techCalendar/pending.ts`
- Test: `app/tests/lib/techCalendar/pending.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

/**
 * Жёлтый статус ставится в двух местах: при открытии экрана и в прогоне
 * напоминаний. Обе точки зовут одну функцию, поэтому статус не зависит от
 * того, кто пришёл раньше — человек или робот. Тест держит идемпотентность:
 * второй прогон не должен трогать ничего.
 */

import { createMockSupabase } from '../../helpers/mockSupabase';
import { refreshPendingReview } from '@/lib/techCalendar/pending';

const TODAY = '2026-08-13';

function row(over: Record<string, unknown>) {
  return { id: 'x', status: 'active', next_billing_date: '2026-09-01', ...over };
}

describe('refreshPendingReview', () => {
  it('желтит сервисы, до которых семь дней или меньше', async () => {
    const db = createMockSupabase({
      tables: {
        tech_subscriptions: [
          row({ id: 'a', next_billing_date: '2026-08-20' }),
          row({ id: 'b', next_billing_date: '2026-08-21' }),
        ],
      },
    });

    const changed = await refreshPendingReview(db as never, TODAY);

    expect(changed).toBe(1);
    const rows = db.getRows('tech_subscriptions');
    expect(rows.find((r) => r.id === 'a')?.status).toBe('pending_review');
    expect(rows.find((r) => r.id === 'b')?.status).toBe('active');
  });

  it('желтит просроченные', async () => {
    const db = createMockSupabase({
      tables: { tech_subscriptions: [row({ id: 'a', next_billing_date: '2026-08-01' })] },
    });

    expect(await refreshPendingReview(db as never, TODAY)).toBe(1);
    expect(db.getRows('tech_subscriptions')[0].status).toBe('pending_review');
  });

  it('не трогает решённые и отменённые', async () => {
    const db = createMockSupabase({
      tables: {
        tech_subscriptions: [
          row({ id: 'a', status: 'keep', next_billing_date: '2026-08-14' }),
          row({ id: 'b', status: 'cancel', next_billing_date: '2026-08-14' }),
          row({ id: 'c', status: 'pending_review', next_billing_date: '2026-08-14' }),
        ],
      },
    });

    expect(await refreshPendingReview(db as never, TODAY)).toBe(0);
  });

  it('идемпотентна: второй прогон ничего не меняет', async () => {
    const db = createMockSupabase({
      tables: { tech_subscriptions: [row({ id: 'a', next_billing_date: '2026-08-15' })] },
    });

    expect(await refreshPendingReview(db as never, TODAY)).toBe(1);
    expect(await refreshPendingReview(db as never, TODAY)).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `cd app && npx jest tests/lib/techCalendar/pending.test.ts --silent`
Expected: FAIL — `Cannot find module '@/lib/techCalendar/pending'`.

- [ ] **Step 3: Написать модуль**

```ts
/**
 * Перевод сервисов в «ожидает решения» за неделю до списания.
 *
 * Зовётся из двух мест: из GET списка (человек открыл экран) и из прогона
 * напоминаний (робот пришёл раньше человека). Функция идемпотентна, поэтому
 * порядок вызовов роли не играет.
 *
 * Обновление идёт по одному сервису, а не одним `update ... in (...)`:
 * желтеющих за раз — единицы, зато код остаётся на том подмножестве
 * supabase-js, которое покрыто тестовым моком, и не зависит от того, как
 * PostgREST разложит массовый фильтр.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { addDays } from '@/lib/techCalendar/dates';
import { PENDING_REVIEW_DAYS } from '@/lib/techCalendar/types';

export async function refreshPendingReview(db: SupabaseClient, todayStr: string): Promise<number> {
  const cutoff = addDays(todayStr, PENDING_REVIEW_DAYS);

  const { data, error } = await db
    .from('tech_subscriptions')
    .select('id')
    .eq('status', 'active')
    .lte('next_billing_date', cutoff);

  if (error || !data?.length) return 0;

  let changed = 0;
  for (const row of data as Array<{ id: string }>) {
    const res = await db
      .from('tech_subscriptions')
      .update({ status: 'pending_review' })
      .eq('id', row.id);
    if (!res.error) changed += 1;
  }
  return changed;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что проходит**

Run: `cd app && npx jest tests/lib/techCalendar/pending.test.ts --silent`
Expected: PASS, 4 теста.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/techCalendar/pending.ts app/tests/lib/techCalendar/pending.test.ts
git commit -m "feat(tech-calendar): статус «ожидает решения» за неделю до списания"
```

---

### Task 7: Ручки API

**Files:**
- Create: `app/src/app/api/tech-calendar/subscriptions/route.ts`, `app/src/app/api/tech-calendar/subscriptions/[id]/route.ts`, `app/src/app/api/tech-calendar/subscriptions/[id]/renew/route.ts`, `app/src/app/api/tech-calendar/subscriptions/[id]/decision/route.ts`
- Test: `app/tests/api/techCalendarRoutes.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

/**
 * Ручки календаря технички.
 *
 * Таблица заперта на RLS, и единственный вход в неё — эти ручки, поэтому
 * первое, что пинуется: не-админ не получает ни строки, включая GET. Второе —
 * продление: оно двигает дату на цикл и сбрасывает решение, и именно поэтому
 * живёт отдельной ручкой, а не PATCH'ем.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const TECH_ID = '00000000-0000-4000-8000-000000000002';

let mockDb: MockSupabaseClient = createMockSupabase();
let currentUserId = ADMIN_ID;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'test-token',
  createAuthedSupabaseClient: () => ({
    auth: { getUser: jest.fn(async () => ({ data: { user: { id: currentUserId } } })) },
  }),
}));

function req(body?: unknown): NextRequest {
  return {
    headers: { get: () => 'Bearer test-token' },
    json: async () => body ?? {},
  } as unknown as NextRequest;
}

function subRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    service_name: 'Bright Data',
    service_type: 'proxy',
    amount: 250,
    currency: 'USD',
    billing_cycle: 'monthly',
    next_billing_date: '2026-08-20',
    status: 'pending_review',
    decision_by: null,
    decision_at: null,
    decision_notes: null,
    notes: null,
    created_by: ADMIN_ID,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  currentUserId = ADMIN_ID;
  mockDb = createMockSupabase({
    tables: {
      profiles: [
        { id: ADMIN_ID, role: 'admin' },
        { id: TECH_ID, role: 'technician' },
      ],
      tech_subscriptions: [subRow()],
    },
  });
  jest.resetModules();
});

describe('доступ', () => {
  it('не пускает техника в список', async () => {
    currentUserId = TECH_ID;
    const { GET } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('не пускает техника к продлению', async () => {
    currentUserId = TECH_ID;
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req(), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(403);
  });
});

describe('GET списка', () => {
  it('отдаёт подписки админу', async () => {
    const { GET } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptions).toHaveLength(1);
    expect(json.subscriptions[0].service_name).toBe('Bright Data');
  });
});

describe('POST создания', () => {
  it('заводит сервис и проставляет автора', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await POST(
      req({ service_name: 'Hetzner', service_type: 'server', amount: 4500, currency: 'RUB', next_billing_date: '2026-09-01' }),
    );
    expect(res.status).toBe(200);
    const rows = mockDb.getRows('tech_subscriptions');
    const created = rows.find((r) => r.service_name === 'Hetzner');
    expect(created).toMatchObject({ service_type: 'server', currency: 'RUB', status: 'active', created_by: ADMIN_ID });
  });

  it('отдаёт 400 на битой дате', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await POST(req({ service_name: 'X', next_billing_date: '01.09.2026' }));
    expect(res.status).toBe(400);
  });
});

describe('POST продления', () => {
  it('двигает дату на цикл и сбрасывает решение', async () => {
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow({ status: 'keep', decision_by: ADMIN_ID, decision_at: '2026-08-13T10:00:00.000Z' })],
      },
    });
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({}), { params: Promise.resolve({ id: 'sub-1' }) });

    expect(res.status).toBe(200);
    const row = mockDb.getRows('tech_subscriptions')[0];
    expect(row).toMatchObject({
      next_billing_date: '2026-09-20',
      status: 'active',
      decision_by: null,
      decision_at: null,
    });
  });

  it('принимает ручную дату и сумму', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({ next_billing_date: '2026-09-25', amount: 275 }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')[0]).toMatchObject({
      next_billing_date: '2026-09-25',
      amount: 275,
    });
  });

  it('отдаёт 404 на несуществующем сервисе', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({}), { params: Promise.resolve({ id: 'нет-такого' }) });
    expect(res.status).toBe(404);
  });
});

describe('POST решения', () => {
  it('пишет решение и автора', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/decision/route');
    const res = await POST(req({ decision: 'cancel', notes: 'дорого' }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')[0]).toMatchObject({
      status: 'cancel',
      decision_by: ADMIN_ID,
      decision_notes: 'дорого',
    });
  });
});

describe('DELETE', () => {
  it('удаляет сервис', async () => {
    const { DELETE } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await DELETE(req(), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `cd app && npx jest tests/api/techCalendarRoutes.test.ts --silent`
Expected: FAIL — `Cannot find module '@/app/api/tech-calendar/subscriptions/route'`.

- [ ] **Step 3: Написать ручку списка и создания**

`app/src/app/api/tech-calendar/subscriptions/route.ts`:

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { mskDateStr } from '@/lib/techCalendar/dates';
import { refreshPendingReview } from '@/lib/techCalendar/pending';
import { ValidationError, parseCreateInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

const COLUMNS =
  'id, service_name, service_type, amount, currency, billing_cycle, next_billing_date, status, decision_by, decision_at, decision_notes, notes, created_by, created_at, updated_at';

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  // Жёлтый статус ставим перед выдачей: экран не должен показывать «активна»
  // сервису, до списания которого три дня, только потому что робот ещё не
  // добежал.
  await refreshPendingReview(supabaseAdmin, mskDateStr(new Date()));

  const { data, error } = await supabaseAdmin
    .from('tech_subscriptions')
    .select(COLUMNS)
    .order('next_billing_date', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ subscriptions: data ?? [] });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let input;
  try {
    input = parseCreateInput((await req.json()) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('tech_subscriptions')
    .insert({ ...input, status: 'active', created_by: guard.user.id });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Написать ручку правки и удаления**

`app/src/app/api/tech-calendar/subscriptions/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ValidationError, parsePatchInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  let patch;
  try {
    patch = parsePatchInput((await req.json()) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from('tech_subscriptions').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;
  const { error } = await supabaseAdmin.from('tech_subscriptions').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Написать ручку продления**

`app/src/app/api/tech-calendar/subscriptions/[id]/renew/route.ts`:

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { addCycle } from '@/lib/techCalendar/dates';
import { ValidationError, parseRenewInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Продление — не «правка строки», а переход цикла: дата уезжает вперёд, статус
 * возвращается в «активна», решение обнуляется. Отдельная ручка нужна ровно
 * поэтому: PATCH'ем то же самое сделала бы форма редактирования, случайно
 * затерев решение, принятое пару минут назад.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  let input;
  try {
    input = parseRenewInput((await req.json().catch(() => ({}))) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { data: current, error: loadError } = await supabaseAdmin
    .from('tech_subscriptions')
    .select('id, next_billing_date, billing_cycle')
    .eq('id', id)
    .maybeSingle();

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: 'Сервис не найден' }, { status: 404 });

  const row = current as { next_billing_date: string; billing_cycle: 'monthly' | 'quarterly' | 'yearly' };
  const nextDate = input.next_billing_date ?? addCycle(row.next_billing_date, row.billing_cycle);

  const patch: Record<string, unknown> = {
    next_billing_date: nextDate,
    status: 'active',
    decision_by: null,
    decision_at: null,
    decision_notes: null,
  };
  if (input.amount !== undefined) patch.amount = input.amount;

  const { error } = await supabaseAdmin.from('tech_subscriptions').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, next_billing_date: nextDate });
}
```

- [ ] **Step 6: Написать ручку решения**

`app/src/app/api/tech-calendar/subscriptions/[id]/decision/route.ts`:

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ValidationError, parseDecisionInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  let input;
  try {
    input = parseDecisionInput((await req.json()) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { data: current, error: loadError } = await supabaseAdmin
    .from('tech_subscriptions')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: 'Сервис не найден' }, { status: 404 });

  const { error } = await supabaseAdmin
    .from('tech_subscriptions')
    .update({
      status: input.decision,
      decision_by: guard.user.id,
      decision_at: new Date().toISOString(),
      decision_notes: input.notes,
    })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: Запустить тест и убедиться, что проходит**

Run: `cd app && npx jest tests/api/techCalendarRoutes.test.ts --silent`
Expected: PASS, 10 тестов.

- [ ] **Step 8: Коммит**

```bash
git add app/src/app/api/tech-calendar app/tests/api/techCalendarRoutes.test.ts
git commit -m "feat(tech-calendar): ручки списка, правки, продления и решения"
```

---

### Task 8: Напоминания админам

**Files:**
- Create: `app/src/lib/notifications/techRenewalCron.ts`
- Test: `app/tests/lib/notifications/techRenewalCron.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */

/**
 * Напоминания о продлении технички.
 *
 * Порог намеренно короче семидневного жёлтого статуса: экран подсвечивает
 * списание заранее, а звенит портал за три дня — когда решение пора принимать.
 * Тест держит и порог, и главное свойство прогона: он идёт каждые 10 минут и
 * не имеет права слать одно и то же дважды.
 */

import { createMockSupabase } from '../../helpers/mockSupabase';
import { runTechRenewalNotifications } from '@/lib/notifications/techRenewalCron';

const ADMIN_A = 'admin-a';
const ADMIN_B = 'admin-b';
const NOW = new Date('2026-08-13T09:00:00Z');

function profiles() {
  return [
    { id: ADMIN_A, role: 'admin' },
    { id: ADMIN_B, role: 'admin' },
    { id: 'tech-1', role: 'technician' },
    { id: 'lead-1', role: 'lead' },
  ];
}

function sub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    service_name: 'Bright Data',
    amount: 250,
    currency: 'USD',
    next_billing_date: '2026-08-15',
    status: 'pending_review',
    ...over,
  };
}

function seed(subs: Array<Record<string, unknown>>, log: Array<Record<string, unknown>> = []) {
  return createMockSupabase({
    tables: {
      tech_subscriptions: subs,
      profiles: profiles(),
      notifications: [],
      tech_renewal_notification_log: log,
    },
  });
}

describe('runTechRenewalNotifications', () => {
  it('шлёт напоминание каждому админу и никому больше', async () => {
    const db = seed([sub()]);

    const result = await runTechRenewalNotifications({ db: db as never, now: NOW });

    expect(result.created).toBe(2);
    const notifs = db.getRows('notifications');
    expect(notifs.map((n) => n.user_id).sort()).toEqual([ADMIN_A, ADMIN_B]);
    expect(notifs[0]).toMatchObject({
      type: 'tech_renewal',
      entity_type: 'tech_subscription',
      entity_id: 'sub-1',
      is_read: false,
    });
    expect(String(notifs[0].title)).toContain('Bright Data');
  });

  it('молчит за четыре дня и звенит за три', async () => {
    const quiet = seed([sub({ next_billing_date: '2026-08-17' })]);
    expect((await runTechRenewalNotifications({ db: quiet as never, now: NOW })).created).toBe(0);

    const loud = seed([sub({ next_billing_date: '2026-08-16' })]);
    expect((await runTechRenewalNotifications({ db: loud as never, now: NOW })).created).toBe(2);
  });

  it('не шлёт второй раз при повторном прогоне', async () => {
    const db = seed([sub()]);

    await runTechRenewalNotifications({ db: db as never, now: NOW });
    const second = await runTechRenewalNotifications({ db: db as never, now: NOW });

    expect(second.created).toBe(0);
    expect(db.getRows('notifications')).toHaveLength(2);
  });

  it('в день оплаты шлёт отдельное напоминание', async () => {
    const db = seed(
      [sub({ next_billing_date: '2026-08-13' })],
      [{ subscription_id: 'sub-1', billing_date: '2026-08-13', level: 'soon' }],
    );

    const result = await runTechRenewalNotifications({ db: db as never, now: NOW });

    expect(result.created).toBe(2);
    expect(db.getRows('tech_renewal_notification_log').map((r) => r.level).sort()).toEqual(['due', 'soon']);
  });

  it('после продления напоминает заново — ключ включает дату', async () => {
    const db = seed(
      [sub({ next_billing_date: '2026-09-15' })],
      [{ subscription_id: 'sub-1', billing_date: '2026-08-15', level: 'soon' }],
    );

    const quiet = await runTechRenewalNotifications({ db: db as never, now: NOW });
    expect(quiet.created).toBe(0);

    const later = await runTechRenewalNotifications({
      db: db as never,
      now: new Date('2026-09-13T09:00:00Z'),
    });
    expect(later.created).toBe(2);
  });

  it('не напоминает про отменённые', async () => {
    const db = seed([sub({ status: 'cancel' })]);
    expect((await runTechRenewalNotifications({ db: db as never, now: NOW })).created).toBe(0);
  });

  it('напоминает про оставленные в день оплаты', async () => {
    const db = seed([sub({ status: 'keep', next_billing_date: '2026-08-13' })]);
    const result = await runTechRenewalNotifications({ db: db as never, now: NOW });
    expect(result.created).toBe(2);
  });

  it('просроченный сервис не звенит второй раз на ту же дату', async () => {
    const db = seed([sub({ next_billing_date: '2026-08-10' })]);

    await runTechRenewalNotifications({ db: db as never, now: NOW });
    const next = await runTechRenewalNotifications({
      db: db as never,
      now: new Date('2026-08-14T09:00:00Z'),
    });

    expect(next.created).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `cd app && npx jest tests/lib/notifications/techRenewalCron.test.ts --silent`
Expected: FAIL — `Cannot find module '@/lib/notifications/techRenewalCron'`.

- [ ] **Step 3: Написать модуль**

```ts
/**
 * Напоминания о продлении технички.
 *
 * Живёт в том же десятиминутном прогоне, что и дедлайны: отдельный крон ради
 * одной выборки — лишняя движущаяся часть, которую пришлось бы отдельно
 * заводить в воркере и в Vercel.
 *
 * Два повода на цикл: `soon` — за три дня до списания, `due` — в день списания
 * и позже. Порог короче семидневного жёлтого статуса намеренно: экран
 * подсвечивает заранее, звенит портал ближе к дате.
 *
 * Уведомление ничем не гасится, кроме прочтения. Продление сервиса старые
 * уведомления не трогает: «уже кто-то продлил» знает только тот, кто продлил,
 * а остальные админы должны увидеть новость, а не пустой колокольчик.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { addDays, daysUntil, mskDateStr } from '@/lib/techCalendar/dates';
import { formatMoney } from '@/lib/techCalendar/money';
import { refreshPendingReview } from '@/lib/techCalendar/pending';
import type { Currency } from '@/lib/techCalendar/types';

export const RENEWAL_NOTIFY_DAYS = 3;

type Level = 'soon' | 'due';

export interface TechRenewalDeps {
  db: SupabaseClient;
  now: Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

export interface TechRenewalResult {
  processed: number;
  created: number;
}

interface SubRow {
  id: string;
  service_name: string;
  amount: number;
  currency: Currency;
  next_billing_date: string;
  status: string;
}

interface LogRow {
  subscription_id: string;
  billing_date: string;
  level: string;
}

function formatDay(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

function buildContent(sub: SubRow, level: Level): { title: string; body: string } {
  const money = formatMoney(sub.amount, sub.currency);
  return {
    title: `Продление: ${sub.service_name}`,
    body:
      level === 'soon'
        ? `${money}, списание ${formatDay(sub.next_billing_date)}. Решите: продлить или отменить.`
        : `${money}, списание ${formatDay(sub.next_billing_date)} — дата наступила. Решите: продлить или отменить.`,
  };
}

export async function runTechRenewalNotifications(deps: TechRenewalDeps): Promise<TechRenewalResult> {
  const { db, now } = deps;
  const log = deps.log ?? ((level, msg, extra) => {
    if (extra !== undefined) console[level](`[tech-renewal-cron] ${msg}`, extra);
    else console[level](`[tech-renewal-cron] ${msg}`);
  });

  const today = mskDateStr(now);

  // Жёлтый статус и напоминание — про одно и то же приближение даты, поэтому
  // статус подтягиваем здесь же: иначе он ждал бы, пока кто-нибудь откроет экран.
  await refreshPendingReview(db, today);

  const cutoff = addDays(today, RENEWAL_NOTIFY_DAYS);
  const subsRes = await db
    .from('tech_subscriptions')
    .select('id, service_name, amount, currency, next_billing_date, status')
    .neq('status', 'cancel')
    .lte('next_billing_date', cutoff);

  if (subsRes.error) {
    log('error', `subscriptions query failed: ${subsRes.error.message}`);
    return { processed: 0, created: 0 };
  }

  const subs = (subsRes.data ?? []) as SubRow[];
  if (!subs.length) return { processed: 0, created: 0 };

  const logRes = await db
    .from('tech_renewal_notification_log')
    .select('subscription_id, billing_date, level')
    .in('subscription_id', subs.map((s) => s.id));

  const sent = new Set(
    ((logRes.data ?? []) as LogRow[]).map((r) => `${r.subscription_id}:${r.billing_date}:${r.level}`),
  );

  const adminsRes = await db.from('profiles').select('id').eq('role', 'admin');
  const admins = ((adminsRes.data ?? []) as Array<{ id: string }>).map((a) => a.id);
  if (!admins.length) {
    log('warn', 'нет ни одного админа — напоминания некому слать');
    return { processed: subs.length, created: 0 };
  }

  let created = 0;

  for (const sub of subs) {
    const level: Level = daysUntil(sub.next_billing_date, today) <= 0 ? 'due' : 'soon';
    const key = `${sub.id}:${sub.next_billing_date}:${level}`;
    if (sent.has(key)) continue;

    const { title, body } = buildContent(sub, level);
    const rows = admins.map((userId) => ({
      user_id: userId,
      type: 'tech_renewal',
      title,
      body,
      entity_type: 'tech_subscription',
      entity_id: sub.id,
      is_read: false,
    }));

    const insertRes = await db.from('notifications').insert(rows);
    if (insertRes.error) {
      log('error', `insert notification failed: ${insertRes.error.message}`);
      continue;
    }

    const upsertRes = await db.from('tech_renewal_notification_log').upsert(
      { subscription_id: sub.id, billing_date: sub.next_billing_date, level },
      { onConflict: 'subscription_id,billing_date,level' },
    );
    if (upsertRes.error) log('error', `dedup log upsert failed: ${upsertRes.error.message}`);

    sent.add(key);
    created += rows.length;
  }

  return { processed: subs.length, created };
}
```

- [ ] **Step 4: Запустить тест и убедиться, что проходит**

Run: `cd app && npx jest tests/lib/notifications/techRenewalCron.test.ts --silent`
Expected: PASS, 8 тестов.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/notifications/techRenewalCron.ts app/tests/lib/notifications/techRenewalCron.test.ts
git commit -m "feat(tech-calendar): напоминания админам за 3 дня и в день оплаты"
```

---

### Task 9: Подключить напоминания к прогону

**Files:**
- Modify: `app/src/app/api/cron/deadline-notifications/route.ts`
- Modify: `app/worker/index.ts` (функция `deadlineNotificationsLoop`)
- Modify: `app/src/app/notifications/page.tsx`

- [ ] **Step 1: Дописать вызов в роут крона**

В `app/src/app/api/cron/deadline-notifications/route.ts` добавить импорт и вызов:

```ts
import { runTechRenewalNotifications } from '@/lib/notifications/techRenewalCron';
```

и внутри `run()` после `const lead = await runLeadEscalation(...)`:

```ts
  const techRenewals = await runTechRenewalNotifications({ db: supabaseAdmin, now });

  return NextResponse.json({
    processed: deadline.processed,
    created: deadline.created,
    lead_escalated: lead.created,
    tech_renewals: techRenewals.created,
  });
```

- [ ] **Step 2: Дописать вызов в воркер**

Найти `deadlineNotificationsLoop` в `app/worker/index.ts` (объявление рядом со строкой 929, где стоит комментарий «Start deadline-notifications loop»). Внутри тела цикла, там же, где вызываются `runDeadlineNotifications` и `runLeadEscalation`, добавить:

```ts
      const techRenewals = await runTechRenewalNotifications({ db: supabaseAdmin, now: new Date() });
      if (techRenewals.created) {
        log('info', `tech renewal notifications created: ${techRenewals.created}`);
      }
```

и импорт наверху файла:

```ts
import { runTechRenewalNotifications } from '../src/lib/notifications/techRenewalCron';
```

Импорт писать в том же стиле, что уже используют соседние импорты `runDeadlineNotifications` / `runLeadEscalation` в этом файле — если они идут через `@/lib/...`, использовать `@/lib/notifications/techRenewalCron`.

- [ ] **Step 3: Показать уведомление в интерфейсе**

В `app/src/app/notifications/page.tsx`, в функции `typeLabel`, добавить ветку перед `default`:

```ts
    case 'tech_renewal': return locale === 'en' ? 'Service renewal' : 'Продление сервиса';
```

и сделать карточку уведомления с `entity_type === 'tech_subscription'` кликабельной — обернуть содержимое строки в переход на календарь:

```tsx
{n.entity_type === 'tech_subscription' ? (
  <a href="/tech-calendar" className="block hover:opacity-80" onClick={() => markOneRead(n.id)}>
    {cardBody}
  </a>
) : (
  cardBody
)}
```

где `cardBody` — уже существующая разметка строки уведомления, вынесенная в переменную внутри `map`.

- [ ] **Step 4: Проверить сборку воркера и типы**

Run: `cd app && npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок в изменённых файлах.

Run: `cd app && npx jest tests/lib/notifications --silent`
Expected: PASS — старые тесты дедлайнов не сломаны.

- [ ] **Step 5: Коммит**

```bash
git add app/src/app/api/cron/deadline-notifications/route.ts app/worker/index.ts app/src/app/notifications/page.tsx
git commit -m "feat(tech-calendar): напоминания в общем прогоне и в списке уведомлений"
```

---

### Task 10: Доступ и меню

**Files:**
- Modify: `app/src/lib/navigation.ts:76`
- Modify: `app/src/middleware.ts:549`
- Create: `app/src/app/tech-calendar/layout.tsx`

- [ ] **Step 1: Добавить пункт меню**

В `app/src/lib/navigation.ts` сразу после строки с `billing-calendar`:

```ts
  { id: 'tech-calendar', name: 'Календарь технички', nameEn: 'Tech calendar', href: '/tech-calendar', adminOnly: true },
```

Правило `adminOnly` уже разбирается в `isNavItemVisible` — ничего больше в этом файле не нужно.

- [ ] **Step 2: Закрыть путь в middleware**

В `app/src/middleware.ts` после блока `if (user && pathname.startsWith('/billing-calendar'))`:

```ts
    // Календарь технички — только админ: суммы по инфраструктуре студии.
    if (user && pathname.startsWith('/tech-calendar')) {
      if (userRole !== 'admin') {
        return NextResponse.redirect(new URL('/', request.url))
      }
    }
```

- [ ] **Step 3: Написать layout страницы**

`app/src/app/tech-calendar/layout.tsx`:

```tsx
'use client';

import { type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/lib/UserProvider';
import { isAdmin } from '@/lib/roles';

export default function TechCalendarLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { userRole } = useUser();

  if (userRole === null) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-gray-400 text-sm">Проверка доступа...</div>
      </div>
    );
  }

  if (!isAdmin(userRole)) {
    router.replace('/');
    return null;
  }

  return <>{children}</>;
}
```

- [ ] **Step 4: Коммит**

```bash
git add app/src/lib/navigation.ts app/src/middleware.ts app/src/app/tech-calendar/layout.tsx
git commit -m "feat(tech-calendar): пункт меню и админский доступ"
```

---

### Task 11: Части интерфейса

**Files:**
- Create: `app/src/components/tech-calendar/statusStyles.ts`, `StatsRow.tsx`, `TypeBreakdown.tsx`, `MonthGrid.tsx`, `UpcomingList.tsx`, `SubscriptionModal.tsx`

- [ ] **Step 1: Написать стили статусов**

`app/src/components/tech-calendar/statusStyles.ts`:

```ts
/**
 * Цвета статусов. Те же, что в календаре почт: два календаря стоят рядом в
 * меню, и разная палитра для одинаковых по смыслу состояний читалась бы как
 * разный смысл.
 */
import type { TechStatus } from '@/lib/techCalendar/types';

export const STATUS_STYLES: Record<TechStatus, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  pending_review: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  keep: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancel: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
};
```

- [ ] **Step 2: Написать плитки**

`app/src/components/tech-calendar/StatsRow.tsx`:

```tsx
'use client';

import { formatTotals } from '@/lib/techCalendar/money';
import { activeCount, decisionsDueWithin, monthTotals, pendingCount } from '@/lib/techCalendar/stats';
import type { TechSubscription } from '@/lib/techCalendar/types';

interface Props {
  subscriptions: TechSubscription[];
  year: number;
  month: number;
  today: string;
}

function Card({ label, values, accent }: { label: string; values: string[]; accent?: 'amber' | 'blue' }) {
  const color = accent === 'amber' ? 'text-amber-600' : accent === 'blue' ? 'text-blue-600' : 'text-gray-900';
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 space-y-0.5 text-2xl font-semibold ${color}`}>
        {values.map((v) => (
          <div key={v}>{v}</div>
        ))}
      </div>
    </div>
  );
}

export default function StatsRow({ subscriptions, year, month, today }: Props) {
  const pending = pendingCount(subscriptions);
  const due = decisionsDueWithin(subscriptions, today);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Активных сервисов" values={[String(activeCount(subscriptions))]} />
      <Card label="Ожидают решения" values={[String(pending)]} accent={pending ? 'amber' : undefined} />
      <Card label="За этот месяц" values={formatTotals(monthTotals(subscriptions, year, month))} />
      <Card label="Решений на 7 дней" values={[String(due)]} accent={due ? 'blue' : undefined} />
    </div>
  );
}
```

- [ ] **Step 3: Написать фильтр по типам**

`app/src/components/tech-calendar/TypeBreakdown.tsx`:

```tsx
'use client';

import { formatTotals } from '@/lib/techCalendar/money';
import { totalsByType } from '@/lib/techCalendar/stats';
import { SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceType, type TechSubscription } from '@/lib/techCalendar/types';

interface Props {
  subscriptions: TechSubscription[];
  year: number;
  month: number;
  selected: ServiceType | null;
  onSelect: (type: ServiceType | null) => void;
}

export default function TypeBreakdown({ subscriptions, year, month, selected, onSelect }: Props) {
  const totals = totalsByType(subscriptions, year, month);

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`rounded-lg border px-3 py-2 text-sm ${selected === null ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700'}`}
      >
        Все типы
      </button>
      {SERVICE_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          onClick={() => onSelect(selected === type ? null : type)}
          className={`rounded-lg border px-3 py-2 text-left text-sm ${selected === type ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700'}`}
        >
          <div>{SERVICE_TYPE_LABELS[type]}</div>
          <div className="text-xs text-gray-500">{formatTotals(totals[type]).join(' · ')}</div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Написать сетку месяца**

`app/src/components/tech-calendar/MonthGrid.tsx`:

```tsx
'use client';

import { useState } from 'react';

import { getDaysInMonth, getFirstDayOfMonth, toDateStr } from '@/lib/techCalendar/dates';
import { addMoney, emptyTotals, formatMoney, formatTotals } from '@/lib/techCalendar/money';
import { STATUS_LABELS, type TechSubscription } from '@/lib/techCalendar/types';
import { STATUS_STYLES } from '@/components/tech-calendar/statusStyles';

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface Props {
  subscriptions: TechSubscription[];
  year: number;
  month: number;
  today: string;
  onSelect: (sub: TechSubscription) => void;
}

function dayTotals(subs: TechSubscription[]) {
  return subs
    .filter((s) => s.status !== 'cancel')
    .reduce((acc, s) => addMoney(acc, s.currency, s.amount), emptyTotals());
}

export default function MonthGrid({ subscriptions, year, month, today, onSelect }: Props) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  // Попап дня: в клетке помещаются два-три сервиса, а в день переоформления
  // пула прокси их бывает с десяток — итог за день иначе пришлось бы считать
  // глазами.
  const [openDay, setOpenDay] = useState<string | null>(null);

  const byDate = new Map<string, TechSubscription[]>();
  for (const sub of subscriptions) {
    const list = byDate.get(sub.next_billing_date) ?? [];
    list.push(sub);
    byDate.set(sub.next_billing_date, list);
  }

  const openSubs = openDay ? (byDate.get(openDay) ?? []) : [];

  return (
    <div className="relative overflow-hidden rounded-xl border border-gray-100 bg-white">
      <div className="grid grid-cols-7 border-b border-gray-100">
        {DAY_NAMES.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-xs font-medium text-gray-500">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {Array.from({ length: firstDay }).map((_, i) => (
          <div key={`pad-${i}`} className="min-h-24 border-b border-r border-gray-50" />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const dateStr = toDateStr(year, month, day);
          const subs = byDate.get(dateStr) ?? [];
          const isToday = dateStr === today;
          return (
            <div key={dateStr} className="min-h-24 border-b border-r border-gray-50 p-1.5 align-top">
              <button
                type="button"
                onClick={() => setOpenDay(subs.length ? dateStr : null)}
                className={`mb-1 text-xs ${isToday ? 'font-semibold text-blue-600' : 'text-gray-400'}`}
              >
                {day}
              </button>
              <div className="space-y-1">
                {subs.map((sub) => {
                  const style = STATUS_STYLES[sub.status];
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => onSelect(sub)}
                      className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] ${style.bg} ${style.text}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                      <span className="truncate">{sub.service_name}</span>
                      <span className="ml-auto shrink-0">{formatMoney(sub.amount, sub.currency)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {openDay && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10 p-4" onClick={() => setOpenDay(null)}>
          <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-900">{openDay}</div>
              <button type="button" onClick={() => setOpenDay(null)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="space-y-1">
              {openSubs.map((sub) => {
                const style = STATUS_STYLES[sub.status];
                return (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => {
                      setOpenDay(null);
                      onSelect(sub);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-gray-50"
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                    <span className="truncate">{sub.service_name}</span>
                    <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 ${style.bg} ${style.text}`}>
                      {STATUS_LABELS[sub.status]}
                    </span>
                    <span className="shrink-0 font-medium">{formatMoney(sub.amount, sub.currency)}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 border-t border-gray-100 pt-2 text-sm font-medium text-gray-900">
              Итого: {formatTotals(dayTotals(openSubs)).join(' · ')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Написать список ближайших**

`app/src/components/tech-calendar/UpcomingList.tsx`:

```tsx
'use client';

import { daysUntil } from '@/lib/techCalendar/dates';
import { formatMoney } from '@/lib/techCalendar/money';
import { upcoming } from '@/lib/techCalendar/stats';
import { SERVICE_TYPE_LABELS, STATUS_LABELS, type TechSubscription } from '@/lib/techCalendar/types';
import { STATUS_STYLES } from '@/components/tech-calendar/statusStyles';

interface Props {
  subscriptions: TechSubscription[];
  today: string;
  onRenew: (sub: TechSubscription) => void;
  onDecide: (sub: TechSubscription, decision: 'keep' | 'cancel') => void;
}

function whenLabel(dateStr: string, today: string): string {
  const d = daysUntil(dateStr, today);
  if (d < 0) return `просрочено на ${Math.abs(d)} дн.`;
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  return `через ${d} дн.`;
}

export default function UpcomingList({ subscriptions, today, onRenew, onDecide }: Props) {
  const items = upcoming(subscriptions, today);
  if (!items.length) return null;

  return (
    <div className="rounded-xl border border-gray-100 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Ближайшие 7 дней</h2>
        <p className="mt-0.5 text-xs text-gray-500">Сервисы, по которым скоро списание</p>
      </div>
      <div className="divide-y divide-gray-50">
        {items.map((sub) => {
          const style = STATUS_STYLES[sub.status];
          return (
            <div key={sub.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-gray-900">{sub.service_name}</div>
                <div className="text-xs text-gray-500">
                  {SERVICE_TYPE_LABELS[sub.service_type]} · {sub.next_billing_date} · {whenLabel(sub.next_billing_date, today)}
                </div>
              </div>
              <div className="text-sm font-medium text-gray-900">{formatMoney(sub.amount, sub.currency)}</div>
              <span className={`rounded px-2 py-1 text-xs ${style.bg} ${style.text}`}>{STATUS_LABELS[sub.status]}</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onRenew(sub)}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700"
                >
                  Оплачено — продлить
                </button>
                <button
                  type="button"
                  onClick={() => onDecide(sub, 'keep')}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  Оставить
                </button>
                <button
                  type="button"
                  onClick={() => onDecide(sub, 'cancel')}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                >
                  Отменить
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Написать модалку**

`app/src/components/tech-calendar/SubscriptionModal.tsx`:

```tsx
'use client';

import { useState } from 'react';

import { addCycle } from '@/lib/techCalendar/dates';
import {
  BILLING_CYCLES,
  CURRENCIES,
  CYCLE_LABELS,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  type TechSubscription,
} from '@/lib/techCalendar/types';

export type ModalMode = 'create' | 'edit' | 'renew';

export interface ModalPayload {
  service_name: string;
  service_type: string;
  amount: number;
  currency: string;
  billing_cycle: string;
  next_billing_date: string;
  notes: string | null;
}

interface Props {
  mode: ModalMode;
  subscription: TechSubscription | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: ModalPayload) => void;
  /** Удаление живёт в самой карточке: отдельная кнопка на странице попадалась бы под руку случайно. */
  onDelete?: () => void;
}

const EMPTY: ModalPayload = {
  service_name: '',
  service_type: 'other',
  amount: 0,
  currency: 'RUB',
  billing_cycle: 'monthly',
  next_billing_date: '',
  notes: null,
};

/**
 * Одно окно на три сценария. В режиме продления дата предзаполнена сдвигом на
 * цикл, но её и сумму можно поправить: цены на прокси и серверы меняются от
 * продления к продлению, и правят их обычно ровно в этот момент.
 */
export default function SubscriptionModal({ mode, subscription, saving, error, onClose, onSubmit, onDelete }: Props) {
  const [form, setForm] = useState<ModalPayload>(() => {
    if (!subscription) return EMPTY;
    const base: ModalPayload = {
      service_name: subscription.service_name,
      service_type: subscription.service_type,
      amount: subscription.amount,
      currency: subscription.currency,
      billing_cycle: subscription.billing_cycle,
      next_billing_date: subscription.next_billing_date,
      notes: subscription.notes,
    };
    if (mode === 'renew') {
      base.next_billing_date = addCycle(subscription.next_billing_date, subscription.billing_cycle);
    }
    return base;
  });

  const title = mode === 'create' ? 'Новый сервис' : mode === 'renew' ? 'Продление' : 'Редактирование';
  const readOnlyFields = mode === 'renew';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-gray-500">Название сервиса</span>
            <input
              value={form.service_name}
              disabled={readOnlyFields}
              onChange={(e) => setForm({ ...form, service_name: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
            />
          </label>

          <label className="block">
            <span className="text-xs text-gray-500">Тип</span>
            <select
              value={form.service_type}
              disabled={readOnlyFields}
              onChange={(e) => setForm({ ...form, service_type: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
            >
              {SERVICE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SERVICE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-500">Сумма</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">Валюта</span>
              <select
                value={form.currency}
                disabled={readOnlyFields}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c === 'RUB' ? '₽ рубли' : '$ доллары'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-gray-500">Цикл оплаты</span>
            <select
              value={form.billing_cycle}
              disabled={readOnlyFields}
              onChange={(e) => setForm({ ...form, billing_cycle: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
            >
              {BILLING_CYCLES.map((c) => (
                <option key={c} value={c}>
                  {CYCLE_LABELS[c]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-gray-500">
              {mode === 'renew' ? 'Следующее списание после продления' : 'Дата следующего списания'}
            </span>
            <input
              type="date"
              value={form.next_billing_date}
              onChange={(e) => setForm({ ...form, next_billing_date: e.target.value })}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs text-gray-500">Заметка</span>
            <textarea
              value={form.notes ?? ''}
              disabled={readOnlyFields}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
            />
          </label>
        </div>

        {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

        <div className="mt-4 flex items-center justify-end gap-2">
          {mode === 'edit' && onDelete && (
            <button type="button" onClick={onDelete} className="mr-auto text-xs text-red-600 hover:underline">
              Удалить сервис
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700">
            Отмена
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onSubmit(form)}
            className={`rounded-lg px-4 py-2 text-sm text-white disabled:opacity-60 ${mode === 'renew' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {saving ? 'Сохранение…' : mode === 'renew' ? 'Продлить' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Коммит**

```bash
git add app/src/components/tech-calendar
git commit -m "feat(tech-calendar): части интерфейса календаря"
```

---

### Task 12: Страница

**Files:**
- Create: `app/src/app/tech-calendar/page.tsx`, `app/src/app/tech-calendar/TechCalendarView.tsx`

- [ ] **Step 1: Написать точку входа**

`app/src/app/tech-calendar/page.tsx`:

```tsx
'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

const TechCalendarView = dynamic(() => import('./TechCalendarView'), {
  loading: () => (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-gray-500">
      <Loader2 className="h-8 w-8 animate-spin text-blue-600" aria-hidden />
      <p className="text-sm">Загрузка календаря технички…</p>
    </div>
  ),
});

export default function TechCalendarPage() {
  return <TechCalendarView />;
}
```

- [ ] **Step 2: Написать основной экран**

`app/src/app/tech-calendar/TechCalendarView.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { supabase } from '@/lib/supabaseClient';
import MonthGrid from '@/components/tech-calendar/MonthGrid';
import StatsRow from '@/components/tech-calendar/StatsRow';
import SubscriptionModal, { type ModalMode, type ModalPayload } from '@/components/tech-calendar/SubscriptionModal';
import TypeBreakdown from '@/components/tech-calendar/TypeBreakdown';
import UpcomingList from '@/components/tech-calendar/UpcomingList';
import { mskDateStr } from '@/lib/techCalendar/dates';
import type { ServiceType, TechSubscription } from '@/lib/techCalendar/types';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token ?? ''}`,
  };
}

export default function TechCalendarView() {
  const today = mskDateStr(new Date());
  const [subscriptions, setSubscriptions] = useState<TechSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<ServiceType | null>(null);

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const [modalMode, setModalMode] = useState<ModalMode | null>(null);
  const [modalSub, setModalSub] = useState<TechSubscription | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tech-calendar/subscriptions', { headers: await authHeaders() });
      const json = await res.json();
      setSubscriptions(res.ok ? (json.subscriptions ?? []) : []);
      if (!res.ok) setError(json.error ?? 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(
    () => (typeFilter ? subscriptions.filter((s) => s.service_type === typeFilter) : subscriptions),
    [subscriptions, typeFilter],
  );

  const submit = async (payload: ModalPayload) => {
    setSaving(true);
    setError(null);
    try {
      const headers = await authHeaders();
      let res: Response;
      if (modalMode === 'create') {
        res = await fetch('/api/tech-calendar/subscriptions', { method: 'POST', headers, body: JSON.stringify(payload) });
      } else if (modalMode === 'edit' && modalSub) {
        res = await fetch(`/api/tech-calendar/subscriptions/${modalSub.id}`, { method: 'PATCH', headers, body: JSON.stringify(payload) });
      } else if (modalMode === 'renew' && modalSub) {
        res = await fetch(`/api/tech-calendar/subscriptions/${modalSub.id}/renew`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ next_billing_date: payload.next_billing_date, amount: payload.amount }),
        });
      } else {
        return;
      }

      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Не удалось сохранить');
        return;
      }
      setModalMode(null);
      setModalSub(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const decide = async (sub: TechSubscription, decision: 'keep' | 'cancel') => {
    const res = await fetch(`/api/tech-calendar/subscriptions/${sub.id}/decision`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ decision }),
    });
    if (res.ok) await load();
  };

  const remove = async (sub: TechSubscription) => {
    if (!window.confirm(`Удалить «${sub.service_name}» из календаря?`)) return;
    const res = await fetch(`/api/tech-calendar/subscriptions/${sub.id}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
    if (res.ok) await load();
  };

  const shiftMonth = (delta: number) => {
    const next = month + delta;
    setYear(year + Math.floor(next / 12));
    setMonth(((next % 12) + 12) % 12);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Календарь технички</h1>
          <p className="text-sm text-gray-500">Прокси, серверы, API и софт: что и когда платим</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setModalSub(null);
            setModalMode('create');
          }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Добавить сервис
        </button>
      </div>

      <StatsRow subscriptions={visible} year={year} month={month} today={today} />
      <TypeBreakdown subscriptions={subscriptions} year={year} month={month} selected={typeFilter} onSelect={setTypeFilter} />

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => shiftMonth(-1)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
          ←
        </button>
        <div className="text-sm font-medium text-gray-900">
          {MONTH_NAMES[month]} {year}
        </div>
        <button type="button" onClick={() => shiftMonth(1)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
          →
        </button>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-100 bg-white p-8 text-center text-sm text-gray-500">Загрузка…</div>
      ) : (
        <MonthGrid
          subscriptions={visible}
          year={year}
          month={month}
          today={today}
          onSelect={(sub) => {
            setModalSub(sub);
            setModalMode('edit');
          }}
        />
      )}

      <UpcomingList
        subscriptions={visible}
        today={today}
        onRenew={(sub) => {
          setModalSub(sub);
          setModalMode('renew');
        }}
        onDecide={decide}
      />

      {error && !modalMode && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

      {modalMode && (
        <SubscriptionModal
          mode={modalMode}
          subscription={modalSub}
          saving={saving}
          error={error}
          onClose={() => {
            setModalMode(null);
            setModalSub(null);
            setError(null);
          }}
          onSubmit={submit}
          onDelete={
            modalMode === 'edit' && modalSub
              ? async () => {
                  await remove(modalSub);
                  setModalMode(null);
                  setModalSub(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Проверить типы**

Run: `cd app && npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add app/src/app/tech-calendar
git commit -m "feat(tech-calendar): страница календаря"
```

---

### Task 13: Проверка вживую и документация

**Files:**
- Modify: `docs/portal-product-overview.md`

- [ ] **Step 1: Применить миграцию локально**

Run: `cd app && npm run db:migrate`
Expected: миграция `20260813_0003_tech_subscriptions.sql` применилась без ошибок.

- [ ] **Step 2: Поднять приложение и открыть экран**

Поднять дев-сервер через preview-инструмент (`.claude/launch.json`, конфигурация для `npm run dev:next`), открыть `/tech-calendar` под админом.

Проверить руками:
1. Добавить сервис в рублях с датой через 2 дня — он появляется в сетке жёлтым (статус ставится порогом в 7 дней), плитка «Ожидают решения» = 1.
2. Добавить сервис в долларах в этом же месяце — плитка «За этот месяц» показывает две строки: ₽ и $.
3. Нажать «Оплачено — продлить» — дата уезжает на месяц, статус синий, сервис пропадает из «Ближайших 7 дней».
4. Нажать «Отменить» — сервис краснеет, из суммы месяца исчезает, из календаря не пропадает.
5. Фильтр по типу переключает и сетку, и плитки.
6. Клик по числу в клетке дня открывает попап со списком сервисов и итогом за день по валютам.

- [ ] **Step 3: Проверить напоминание**

Run: `cd app && npx jest tests/lib/notifications/techRenewalCron.test.ts --silent`
Expected: PASS.

Дополнительно — дёрнуть крон локально с секретом из `.env`:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/deadline-notifications
```

Expected: JSON содержит поле `tech_renewals`.

- [ ] **Step 4: Полный прогон тестов и линт**

Run: `cd app && npx jest --silent`
Expected: PASS.

Run: `cd app && npm run lint`
Expected: без ошибок в новых файлах.

- [ ] **Step 5: Дописать документацию**

В `docs/portal-product-overview.md` добавить раздел после «21. Календарь почт»:

```markdown
## 22. Календарь технички

**Путь:** `/tech-calendar` (только админ)

Оплаты студийной технички: прокси, серверы, API, софт.

### Возможности:
- Календарь месяца с датами списаний и суммами
- Сумма за месяц отдельно в рублях и долларах, без конвертации
- Фильтр по типу сервиса и разбивка расходов по типам
- Статусы: активна, ожидает решения (жёлтый за 7 дней), оставить, отменить
- Продление одной кнопкой: дата уезжает на цикл, сумму и дату можно поправить
- Напоминания админам в колокольчик за 3 дня и в день оплаты
```

Также поправить оглавление вверху файла (пункты после 21 сдвигаются на единицу).

- [ ] **Step 6: Коммит**

```bash
git add docs/portal-product-overview.md
git commit -m "docs(tech-calendar): раздел про календарь технички"
```

---

## Порядок и зависимости

Задачи 2–6 независимы друг от друга по коду, но 4 и 6 импортируют `dates.ts` из задачи 3, а 8 — `pending.ts` из задачи 6. Порядок 1 → 13 безопасен целиком. Задачи 11 и 12 требуют завершённой 7 (ручки) и 2 (типы).
