# TG Outreach warmup — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Прогреть свежие Telegram-аккаунты кампании перепиской между собой в течение N дней с нарастающей нагрузкой, прежде чем пускать их на боевых лидов.

**Architecture:** Прогрев — фаза кампании, взаимоисключающая с боевым циклом. Состояние живёт в БД (`tg_outreach_warmup_runs` + `tg_outreach_warmup_conversations`), поэтому переживает перезапуски воркера. Планировщик — чистая функция, считающая нагрузку на аккаунт в день (2→8 переписок) и раскидывающая пары по дневному окну. Обе стороны переписки наши, поэтому рантайм ведёт оба клиента по очереди, без ожидания ответа опросом. Переписки хранятся отдельно от `tg_outreach_dialogs`, чтобы свои аккаунты не попали в лиды.

**Tech Stack:** TypeScript, Next.js API routes, Supabase/Postgres, gramJS (`telegram`), Jest, существующие модули `gramClient.ts`, `proxyHealth.ts`, `openaiChat.ts`.

**Spec:** `docs/superpowers/specs/2026-08-03-tg-outreach-warmup-design.md`

---

## File structure

**Создаём:**

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260803_0006_tg_outreach_warmup.sql` | Таблицы прогрева, колонки личности аккаунта, `account_id` в логах, расширение CHECK на `action` |
| `app/src/lib/tgOutreach/warmup/types.ts` | Типы и константы кривой нагрузки |
| `app/src/lib/tgOutreach/warmup/schedule.ts` | Чистый планировщик: цели по дням, подбор пар, времена |
| `app/src/lib/tgOutreach/warmup/prompt.ts` | Системный промпт бытового трёпа + запасные реплики |
| `app/src/lib/tgOutreach/warmup/conversation.ts` | Проведение одной переписки поверх абстрактных «сторон» |
| `app/src/lib/tgOutreach/warmup/peer.ts` | Выбор стратегии резолва собеседника и её исполнение |
| `app/src/lib/tgOutreach/warmup/identity.ts` | Bootstrap личности аккаунта через `getMe()` |
| `app/src/lib/tgOutreach/warmup/db.ts` | Доступ к БД: создание run, сохранение плана дня, выборка due-переписок, сводка |
| `app/src/lib/tgOutreach/warmup/loop.ts` | Цикл прогрева: день → план → проведение → следующий день |
| `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/route.ts` | GET статус, POST старт, DELETE стоп |
| `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/conversations/route.ts` | GET список переписок с фильтром по аккаунту |
| `app/src/components/tg-outreach/WarmupTab.tsx` | Вкладка «Прогрев» целиком |

**Меняем:**

| Файл | Что |
|---|---|
| `app/worker/tgOutreach.ts:49-50,199-231` | Новые действия `warmup_start` / `warmup_stop` |
| `app/src/app/api/tools/tg-outreach/campaigns/[id]/logs/route.ts` | Фильтр `?account_id=` |
| `app/src/app/tools/tg-outreach/page.tsx:2054-2059` | Вкладка «Прогрев» в списке табов |
| `app/src/lib/tgOutreach/campaignLoop.ts:~1405` | Боевой цикл пропускает диалоги с собственными аккаунтами кампании |

`page.tsx` уже 2256 строк — вкладка выносится отдельным компонентом, внутрь файла логика не добавляется.

---

## Task 1: Миграция

**Files:**
- Create: `supabase/migrations/20260803_0006_tg_outreach_warmup.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- TG Outreach: прогрев аккаунтов перепиской между собой.
-- Дизайн: docs/superpowers/specs/2026-08-03-tg-outreach-warmup-design.md

create table if not exists public.tg_outreach_warmup_runs (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  days         int  not null check (days between 1 and 14),
  status       text not null default 'pending'
               check (status in ('pending','running','finished','stopped','failed')),
  current_day  int  not null default 0,
  started_at   timestamptz,
  finished_at  timestamptz,
  settings     jsonb not null default '{}'::jsonb,
  summary      jsonb,
  error_message text,
  created_at   timestamptz not null default now()
);

create index if not exists tg_outreach_warmup_runs_campaign_idx
  on public.tg_outreach_warmup_runs (campaign_id, created_at desc);

-- Один активный прогрев на кампанию: прогрев и боевой цикл взаимоисключающие.
create unique index if not exists tg_outreach_warmup_runs_one_active_idx
  on public.tg_outreach_warmup_runs (campaign_id)
  where status in ('pending','running');

create table if not exists public.tg_outreach_warmup_conversations (
  id                    bigint generated always as identity primary key,
  run_id                uuid not null references public.tg_outreach_warmup_runs(id) on delete cascade,
  campaign_id           uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  day_no                int  not null,
  -- Пара нормализована: account_a_id < account_b_id как текст uuid.
  account_a_id          uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  account_b_id          uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  initiator_account_id  uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  planned_at            timestamptz not null,
  planned_messages      int not null,
  status                text not null default 'pending'
                        check (status in ('pending','running','done','failed','skipped')),
  started_at            timestamptz,
  finished_at           timestamptz,
  messages              jsonb not null default '[]'::jsonb,
  error_reason          text,
  created_at            timestamptz not null default now()
);

create unique index if not exists tg_outreach_warmup_conv_unique_pair_per_day_idx
  on public.tg_outreach_warmup_conversations (run_id, day_no, account_a_id, account_b_id);

create index if not exists tg_outreach_warmup_conv_due_idx
  on public.tg_outreach_warmup_conversations (run_id, status, planned_at);

create index if not exists tg_outreach_warmup_conv_account_idx
  on public.tg_outreach_warmup_conversations (campaign_id, account_a_id, planned_at desc);

create index if not exists tg_outreach_warmup_conv_account_b_idx
  on public.tg_outreach_warmup_conversations (campaign_id, account_b_id, planned_at desc);

-- Личность самого аккаунта. Сегодня её нигде нет, без неё аккаунты не могут
-- адресовать друг друга: чтобы написать, нужен peer, а не строка в session_name.
alter table public.tg_outreach_accounts
  add column if not exists tg_user_id bigint,
  add column if not exists tg_username text,
  add column if not exists identity_checked_at timestamptz;

comment on column public.tg_outreach_accounts.tg_user_id is
  'Собственный Telegram user id аккаунта, заполняется getMe() при старте прогрева.';

-- Привязка события к аккаунту. Раньше делалась сопоставлением session_name в
-- тексте сообщения — ненадёжно. Существующий код колонку не заполняет.
alter table public.tg_outreach_logs
  add column if not exists account_id uuid references public.tg_outreach_accounts(id) on delete set null;

create index if not exists tg_outreach_logs_account_idx
  on public.tg_outreach_logs (campaign_id, account_id, created_at desc);

alter table public.tg_outreach_jobs drop constraint if exists tg_outreach_jobs_action_check;
alter table public.tg_outreach_jobs add constraint tg_outreach_jobs_action_check
  check (action in ('start','stop','restart','refetch_messages','warmup_start','warmup_stop'));

alter table public.tg_outreach_warmup_runs enable row level security;
alter table public.tg_outreach_warmup_conversations enable row level security;

create policy tg_outreach_warmup_runs_select_all on public.tg_outreach_warmup_runs
  for select to authenticated using (true);
create policy tg_outreach_warmup_conv_select_all on public.tg_outreach_warmup_conversations
  for select to authenticated using (true);

grant all on public.tg_outreach_warmup_runs to service_role;
grant all on public.tg_outreach_warmup_conversations to service_role;
grant select on public.tg_outreach_warmup_runs to authenticated;
grant select on public.tg_outreach_warmup_conversations to authenticated;
```

- [ ] **Step 2: Коммит**

```bash
git add supabase/migrations/20260803_0006_tg_outreach_warmup.sql
git commit -m "feat(tg-outreach): миграция под прогрев аккаунтов"
```

---

## Task 2: Типы и константы кривой

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/types.ts`

- [ ] **Step 1: Написать файл**

```ts
/**
 * Прогрев TG-аккаунтов: типы и константы кривой нагрузки.
 *
 * Числа — оценка правдоподобия поведения, а не измеренные пороги Telegram
 * (их никто не публикует). Держим в константах, чтобы менять без правки логики.
 * Обоснование выбора — в спеке
 * docs/superpowers/specs/2026-08-03-tg-outreach-warmup-design.md.
 */

/** Переписок на аккаунт в первый день прогрева. */
export const CONVERSATIONS_FIRST_DAY = Number(
  process.env.TG_WARMUP_CONVERSATIONS_FIRST_DAY ?? '2',
);

/** Переписок на аккаунт в последний день прогрева. */
export const CONVERSATIONS_LAST_DAY = Number(
  process.env.TG_WARMUP_CONVERSATIONS_LAST_DAY ?? '8',
);

/** Сообщений в одной переписке в первый день. */
export const MESSAGES_FIRST_DAY = Number(process.env.TG_WARMUP_MESSAGES_FIRST_DAY ?? '3');

/** Сообщений в одной переписке в последний день. */
export const MESSAGES_LAST_DAY = Number(process.env.TG_WARMUP_MESSAGES_LAST_DAY ?? '10');

/** Пауза между репликами внутри переписки, секунды. */
export const REPLY_DELAY_RANGE_SEC: [number, number] = [
  Number(process.env.TG_WARMUP_REPLY_DELAY_MIN_SEC ?? '20'),
  Number(process.env.TG_WARMUP_REPLY_DELAY_MAX_SEC ?? '90'),
];

/** Дней прогрева по умолчанию. */
export const DEFAULT_WARMUP_DAYS = Number(process.env.TG_WARMUP_DEFAULT_DAYS ?? '4');

/**
 * Сколько ждать, прежде чем считать зависшую переписку брошенной и вернуть её
 * в очередь. Переписка из 10 реплик с паузами до 90с укладывается в ~15 минут;
 * берём тройной запас, чтобы не подхватить ту, что реально идёт в другом процессе.
 */
export const CONVERSATION_STALE_MINUTES = Number(
  process.env.TG_WARMUP_CONVERSATION_STALE_MIN ?? '45',
);

export type WarmupRunStatus = 'pending' | 'running' | 'finished' | 'stopped' | 'failed';
export type WarmupConversationStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface WarmupRun {
  id: string;
  campaign_id: string;
  days: number;
  status: WarmupRunStatus;
  current_day: number;
  started_at: string | null;
  finished_at: string | null;
  settings: Record<string, unknown>;
  summary: WarmupSummary | null;
  error_message: string | null;
  created_at: string;
}

export interface WarmupMessage {
  account_id: string;
  content: string;
  timestamp: string;
}

export interface WarmupConversation {
  id: number;
  run_id: string;
  campaign_id: string;
  day_no: number;
  account_a_id: string;
  account_b_id: string;
  initiator_account_id: string;
  planned_at: string;
  planned_messages: number;
  status: WarmupConversationStatus;
  started_at: string | null;
  finished_at: string | null;
  messages: WarmupMessage[];
  error_reason: string | null;
}

export interface WarmupSummary {
  accounts_total: number;
  accounts_ok: number;
  accounts_failed: number;
  conversations_done: number;
  conversations_failed: number;
  messages_sent: number;
  per_account: Array<{
    account_id: string;
    session_name: string;
    done: number;
    failed: number;
    last_error: string | null;
  }>;
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/types.ts
git commit -m "feat(tg-outreach): типы и константы прогрева"
```

---

## Task 3: Планировщик — цели по дням

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/schedule.ts`
- Test: `app/tests/lib/tgOutreach/warmupSchedule.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */
import {
  conversationsPerAccount,
  messagesPerConversation,
} from '@/lib/tgOutreach/warmup/schedule';

describe('warmup schedule — кривая нагрузки', () => {
  it('4 дня: переписок на аккаунт растёт 2 → 4 → 6 → 8', () => {
    expect([1, 2, 3, 4].map((d) => conversationsPerAccount(d, 4))).toEqual([2, 4, 6, 8]);
  });

  it('4 дня: длина переписки растёт от 3 до 10 сообщений', () => {
    const lens = [1, 2, 3, 4].map((d) => messagesPerConversation(d, 4));
    expect(lens[0]).toBe(3);
    expect(lens[3]).toBe(10);
    expect(lens[1]).toBeLessThan(lens[2]);
  });

  it('3 дня: те же границы, кривая сжимается', () => {
    expect(conversationsPerAccount(1, 3)).toBe(2);
    expect(conversationsPerAccount(3, 3)).toBe(8);
  });

  it('день вне диапазона зажимается в границы', () => {
    expect(conversationsPerAccount(0, 4)).toBe(2);
    expect(conversationsPerAccount(99, 4)).toBe(8);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd app && npx jest tests/lib/tgOutreach/warmupSchedule.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/warmup/schedule'`

- [ ] **Step 3: Минимальная реализация**

```ts
/**
 * Прогрев: планировщик дня. Чистые функции — вся работа с БД и временем
 * снаружи, поэтому поведение полностью проверяемо тестами.
 */
import {
  CONVERSATIONS_FIRST_DAY,
  CONVERSATIONS_LAST_DAY,
  MESSAGES_FIRST_DAY,
  MESSAGES_LAST_DAY,
} from './types';

function rampValue(day: number, totalDays: number, from: number, to: number): number {
  if (totalDays <= 1) return to;
  const clamped = Math.min(Math.max(day, 1), totalDays);
  const t = (clamped - 1) / (totalDays - 1);
  return Math.round(from + (to - from) * t);
}

/** Сколько переписок должен провести один аккаунт в день `day` из `totalDays`. */
export function conversationsPerAccount(day: number, totalDays: number): number {
  return rampValue(day, totalDays, CONVERSATIONS_FIRST_DAY, CONVERSATIONS_LAST_DAY);
}

/** Сколько сообщений содержит одна переписка в день `day` из `totalDays`. */
export function messagesPerConversation(day: number, totalDays: number): number {
  return rampValue(day, totalDays, MESSAGES_FIRST_DAY, MESSAGES_LAST_DAY);
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `cd app && npx jest tests/lib/tgOutreach/warmupSchedule.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/schedule.ts app/tests/lib/tgOutreach/warmupSchedule.test.ts
git commit -m "feat(tg-outreach): кривая нагрузки прогрева"
```

---

## Task 4: Планировщик — подбор пар на день

**Files:**
- Modify: `app/src/lib/tgOutreach/warmup/schedule.ts`
- Test: `app/tests/lib/tgOutreach/warmupSchedule.test.ts`

- [ ] **Step 1: Дописать падающий тест**

```ts
import { planDay } from '@/lib/tgOutreach/warmup/schedule';

const WINDOW = {
  start: new Date('2026-08-04T08:00:00Z'),
  end: new Date('2026-08-04T22:00:00Z'),
};
const seq = (vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe('warmup schedule — подбор пар', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('каждый аккаунт получает свою дневную норму переписок', () => {
    const plan = planDay({
      accountIds: ids, day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    const count = new Map<string, number>();
    for (const c of plan) {
      count.set(c.accountAId, (count.get(c.accountAId) ?? 0) + 1);
      count.set(c.accountBId, (count.get(c.accountBId) ?? 0) + 1);
    }
    for (const id of ids) expect(count.get(id)).toBe(2);
  });

  it('одна и та же пара не встречается дважды за день', () => {
    const plan = planDay({
      accountIds: ids, day: 4, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    const keys = plan.map((c) => `${c.accountAId}|${c.accountBId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('пара нормализована: accountAId всегда меньше accountBId', () => {
    const plan = planDay({
      accountIds: ids, day: 2, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    for (const c of plan) expect(c.accountAId < c.accountBId).toBe(true);
  });

  it('незнакомые партнёры имеют приоритет над уже знакомыми', () => {
    // a уже говорил с b и c; при норме 1 переписки a должен выбрать d.
    const plan = planDay({
      accountIds: ids, day: 1, totalDays: 1,
      previousPairs: [['a', 'b'], ['a', 'c']],
      window: WINDOW, random: seq([0.5]),
      targetOverride: 1,
    });
    const aPair = plan.find((c) => c.accountAId === 'a' || c.accountBId === 'a');
    expect(aPair).toBeDefined();
    const partner = aPair!.accountAId === 'a' ? aPair!.accountBId : aPair!.accountAId;
    expect(partner).toBe('d');
  });

  it('нечётное число аккаунтов не роняет планировщик', () => {
    const plan = planDay({
      accountIds: ['a', 'b', 'c'], day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.accountAId).not.toBe(c.accountBId);
  });

  it('меньше двух аккаунтов — пустой план, без исключения', () => {
    expect(planDay({
      accountIds: ['a'], day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
  });

  it('времена попадают в окно и идут по возрастанию', () => {
    const plan = planDay({
      accountIds: ids, day: 3, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.1, 0.4, 0.7, 0.9, 0.2, 0.6]),
    });
    const times = plan.map((c) => new Date(c.plannedAt).getTime());
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(WINDOW.start.getTime());
      expect(t).toBeLessThanOrEqual(WINDOW.end.getTime());
    }
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('инициатор — один из участников пары', () => {
    const plan = planDay({
      accountIds: ids, day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.9, 0.1]),
    });
    for (const c of plan) {
      expect([c.accountAId, c.accountBId]).toContain(c.initiatorAccountId);
    }
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd app && npx jest tests/lib/tgOutreach/warmupSchedule.test.ts`
Expected: FAIL — `planDay is not a function`

- [ ] **Step 3: Реализация**

Дописать в `schedule.ts`:

```ts
export interface PlannedConversation {
  accountAId: string;
  accountBId: string;
  initiatorAccountId: string;
  plannedMessages: number;
  plannedAt: string;
}

export interface PlanDayParams {
  accountIds: string[];
  day: number;
  totalDays: number;
  /** Пары, которые уже общались в предыдущие дни (в любом порядке). */
  previousPairs: Array<[string, string]>;
  window: { start: Date; end: Date };
  random: () => number;
  /** Только для тестов: заменить дневную норму переписок на аккаунт. */
  targetOverride?: number;
}

function pairKey(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * Составить план переписок на один день.
 *
 * Жадный подбор: берём аккаунт с наибольшим остатком нормы и ищем ему
 * партнёра — сначала среди тех, с кем он ещё не говорил, потом среди знакомых.
 * Рост нагрузки идёт не только за счёт новых знакомств: когда незнакомые
 * кончаются, аккаунт возвращается к знакомым, а возврат к знакомому
 * собеседнику — самый человеческий сигнал из доступных.
 */
export function planDay(params: PlanDayParams): PlannedConversation[] {
  const { accountIds, day, totalDays, previousPairs, window, random } = params;
  if (accountIds.length < 2) return [];

  const target = params.targetOverride ?? conversationsPerAccount(day, totalDays);
  const plannedMessages = messagesPerConversation(day, totalDays);
  const seen = new Set(previousPairs.map(([x, y]) => pairKey(x, y)));
  const usedToday = new Set<string>();
  const remaining = new Map(accountIds.map((id) => [id, target]));
  const out: Array<Omit<PlannedConversation, 'plannedAt'>> = [];

  for (;;) {
    const candidates = accountIds
      .filter((id) => (remaining.get(id) ?? 0) > 0)
      .sort((x, y) => (remaining.get(y)! - remaining.get(x)!) || (x < y ? -1 : 1));
    if (candidates.length < 2) break;

    const self = candidates[0];
    const partners = candidates
      .slice(1)
      .filter((id) => !usedToday.has(pairKey(self, id)));
    if (!partners.length) {
      remaining.set(self, 0);
      continue;
    }

    const fresh = partners.filter((id) => !seen.has(pairKey(self, id)));
    const partner = (fresh.length ? fresh : partners)[0];

    const [a, b] = self < partner ? [self, partner] : [partner, self];
    usedToday.add(pairKey(a, b));
    seen.add(pairKey(a, b));
    remaining.set(self, remaining.get(self)! - 1);
    remaining.set(partner, remaining.get(partner)! - 1);
    out.push({
      accountAId: a,
      accountBId: b,
      initiatorAccountId: random() < 0.5 ? a : b,
      plannedMessages,
    });
  }

  const spanMs = window.end.getTime() - window.start.getTime();
  const times = out
    .map(() => window.start.getTime() + Math.floor(random() * Math.max(spanMs, 1)))
    .sort((x, y) => x - y);

  return out.map((c, i) => ({ ...c, plannedAt: new Date(times[i]).toISOString() }));
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/warmupSchedule.test.ts`
Expected: PASS, все тесты

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/schedule.ts app/tests/lib/tgOutreach/warmupSchedule.test.ts
git commit -m "feat(tg-outreach): подбор пар на день прогрева"
```

---

## Task 5: Промпт бытового трёпа

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/prompt.ts`

- [ ] **Step 1: Написать файл**

```ts
/**
 * Прогрев: генерация реплик. Промпт намеренно НЕ продающий — это трёп двух
 * приятелей. Продающий промпт кампании сюда не подходит: он тянет разговор к
 * офферу, а нам нужен бытовой фон, по которому Telegram видит живого человека.
 */
import type { OpenAISettings } from '../types';

const WARMUP_SYSTEM_PROMPT = `Ты пишешь в мессенджере обычному приятелю. Пиши как живой человек: коротко, на русском, без формальностей и без деловых тем.

Правила:
- одно сообщение — одна-две фразы, не длиннее 15 слов;
- бытовые темы: погода, планы на вечер, еда, дорога, сериалы, спорт, усталость после работы;
- никаких продаж, услуг, предложений, ссылок, приглашений и обсуждения работы;
- не представляйся и не спрашивай «кто это»: вы давно знакомы;
- не повторяй дословно то, что уже было в переписке;
- иногда отвечай вопросом, иногда просто реагируй;
- без эмодзи в каждом сообщении, изредка можно.

Верни только текст сообщения, без кавычек и пояснений.`;

/** Настройки генерации реплик прогрева для openaiGenerate. */
export function warmupOpenAISettings(): OpenAISettings {
  return {
    system_prompt: WARMUP_SYSTEM_PROMPT,
    project_name: '',
    trigger_phrases_positive: '',
    trigger_phrases_negative: '',
    target_chats_positive: '',
    target_chats_negative: '',
    use_fallback_on_fail: false,
    fallback_text: '',
  } as OpenAISettings;
}

/**
 * Запасные реплики на случай, когда GPT недоступен. Прогрев из-за одного
 * сбойного запроса останавливаться не должен, но и молчать в середине
 * переписки нельзя — это выглядит хуже, чем банальная фраза.
 */
const FALLBACKS = [
  'ага, понял',
  'ну ок, тогда так и сделаем',
  'да, примерно так же',
  'слушай, а давай попозже обсудим',
  'угу, согласен',
  'ладно, тогда до связи',
  'ясно, спасибо',
  'да нормально всё',
];

export function fallbackReply(index: number): string {
  return FALLBACKS[index % FALLBACKS.length];
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/prompt.ts
git commit -m "feat(tg-outreach): промпт бытового трёпа для прогрева"
```

---

## Task 6: Проведение одной переписки

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/conversation.ts`
- Test: `app/tests/lib/tgOutreach/warmupConversation.test.ts`

Обе стороны наши, поэтому рантайм ведёт оба клиента по очереди и не ждёт ответа опросом. Работа идёт поверх абстракции `WarmupSide`, чтобы Telegram не участвовал в тестах.

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */
import { runWarmupConversation, type WarmupSide } from '@/lib/tgOutreach/warmup/conversation';

function fakeSide(accountId: string, sent: Array<{ from: string; text: string }>): WarmupSide {
  return {
    accountId,
    send: async (text: string) => { sent.push({ from: accountId, text }); },
  };
}

const noSleep = async () => {};

describe('warmup conversation', () => {
  it('отправляет ровно запланированное число сообщений', async () => {
    const sent: Array<{ from: string; text: string }> = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 5,
      generate: async () => 'привет', sleep: noSleep, random: () => 0.5,
    });
    expect(sent).toHaveLength(5);
    expect(messages).toHaveLength(5);
  });

  it('стороны чередуются, начиная с инициатора', async () => {
    const sent: Array<{ from: string; text: string }> = [];
    await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'b', plannedMessages: 4,
      generate: async () => 'ок', sleep: noSleep, random: () => 0.5,
    });
    expect(sent.map((m) => m.from)).toEqual(['b', 'a', 'b', 'a']);
  });

  it('история передаётся генератору с правильными ролями', async () => {
    const sent: Array<{ from: string; text: string }> = [];
    const histories: Array<Array<{ role: string; content: string }>> = [];
    let n = 0;
    await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 3,
      generate: async (history) => {
        histories.push(history.map((h) => ({ role: h.role, content: h.content })));
        return `msg${++n}`;
      },
      sleep: noSleep, random: () => 0.5,
    });
    expect(histories[0]).toEqual([]);
    // Второе сообщение пишет B, значит реплики A для него — чужие (user).
    expect(histories[1]).toEqual([{ role: 'user', content: 'msg1' }]);
    // Третье пишет A: его собственная первая реплика — assistant, ответ B — user.
    expect(histories[2]).toEqual([
      { role: 'assistant', content: 'msg1' },
      { role: 'user', content: 'msg2' },
    ]);
  });

  it('пустой ответ GPT заменяется запасной репликой, переписка не прерывается', async () => {
    const sent: Array<{ from: string; text: string }> = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 3,
      generate: async () => null, sleep: noSleep, random: () => 0.5,
    });
    expect(messages).toHaveLength(3);
    for (const m of messages) expect(m.content.length).toBeGreaterThan(0);
  });

  it('падение GPT не роняет переписку', async () => {
    const sent: Array<{ from: string; text: string }> = [];
    const messages = await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 2,
      generate: async () => { throw new Error('gpt down'); },
      sleep: noSleep, random: () => 0.5,
    });
    expect(messages).toHaveLength(2);
  });

  it('ошибка отправки прерывает переписку и пробрасывается наверх', async () => {
    const sent: Array<{ from: string; text: string }> = [];
    const brokenB: WarmupSide = {
      accountId: 'b',
      send: async () => { throw new Error('PEER_FLOOD'); },
    };
    await expect(runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: brokenB,
      initiatorAccountId: 'a', plannedMessages: 4,
      generate: async () => 'привет', sleep: noSleep, random: () => 0.5,
    })).rejects.toThrow('PEER_FLOOD');
    expect(sent).toHaveLength(1);
  });

  it('между репликами выдерживается пауза из диапазона', async () => {
    const sent: Array<{ from: string; text: string }> = [];
    const delays: number[] = [];
    await runWarmupConversation({
      sideA: fakeSide('a', sent), sideB: fakeSide('b', sent),
      initiatorAccountId: 'a', plannedMessages: 3,
      generate: async () => 'ок',
      sleep: async (ms) => { delays.push(ms); },
      random: () => 0.5, delayRangeSec: [10, 20],
    });
    // Пауза перед каждой репликой, кроме первой.
    expect(delays).toHaveLength(2);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(10_000);
      expect(d).toBeLessThanOrEqual(20_000);
    }
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd app && npx jest tests/lib/tgOutreach/warmupConversation.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализация**

```ts
/**
 * Прогрев: проведение одной переписки.
 *
 * Обе стороны наши, поэтому ждать ответа опросом не нужно — ведём оба клиента
 * по очереди. Работа идёт поверх абстракции WarmupSide, чтобы логика чередования
 * и сборки истории проверялась без Telegram.
 */
import type { DialogMessage } from '../types';
import type { WarmupMessage } from './types';
import { REPLY_DELAY_RANGE_SEC } from './types';
import { fallbackReply } from './prompt';

export interface WarmupSide {
  accountId: string;
  send(text: string): Promise<void>;
}

export interface RunWarmupConversationParams {
  sideA: WarmupSide;
  sideB: WarmupSide;
  initiatorAccountId: string;
  plannedMessages: number;
  generate: (history: DialogMessage[]) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  delayRangeSec?: [number, number];
}

/**
 * Провести переписку и вернуть отправленные сообщения.
 *
 * Ошибку отправки НЕ глотаем: не доставленное сообщение означает, что с
 * аккаунтом или прокси что-то не так, и вызывающий код должен пометить
 * переписку failed. А вот сбой GPT глотаем — молчание в середине разговора
 * выглядит хуже банальной фразы.
 */
export async function runWarmupConversation(
  params: RunWarmupConversationParams,
): Promise<WarmupMessage[]> {
  const { sideA, sideB, initiatorAccountId, plannedMessages, generate, sleep, random } = params;
  const [minSec, maxSec] = params.delayRangeSec ?? REPLY_DELAY_RANGE_SEC;

  const first = sideA.accountId === initiatorAccountId ? sideA : sideB;
  const second = first === sideA ? sideB : sideA;
  const out: WarmupMessage[] = [];

  for (let i = 0; i < plannedMessages; i++) {
    const speaker = i % 2 === 0 ? first : second;

    if (i > 0) {
      const sec = minSec + random() * (maxSec - minSec);
      await sleep(Math.round(sec * 1000));
    }

    const history: DialogMessage[] = out.map((m) => ({
      role: m.account_id === speaker.accountId ? 'assistant' : 'user',
      content: m.content,
    }));

    let text: string;
    try {
      text = (await generate(history))?.trim() || fallbackReply(i);
    } catch {
      text = fallbackReply(i);
    }

    await speaker.send(text);
    out.push({
      account_id: speaker.accountId,
      content: text,
      timestamp: new Date().toISOString(),
    });
  }

  return out;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/warmupConversation.test.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/conversation.ts app/tests/lib/tgOutreach/warmupConversation.test.ts
git commit -m "feat(tg-outreach): проведение переписки прогрева"
```

---

## Task 7: Резолв собеседника

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/peer.ts`
- Test: `app/tests/lib/tgOutreach/warmupPeer.test.ts`

Выбор стратегии — чистая функция и покрывается тестами; сам вызов MTProto — тонкая обёртка.

- [ ] **Step 1: Написать падающий тест**

```ts
/** @jest-environment node */
import { chooseResolutionStrategy, normalizePhone } from '@/lib/tgOutreach/warmup/peer';

describe('warmup peer — выбор стратегии', () => {
  it('username выигрывает у телефона: он не требует импорта контакта', () => {
    expect(chooseResolutionStrategy({ tg_username: 'ivan', phone: '998901112233' }))
      .toEqual({ kind: 'username', username: 'ivan' });
  });

  it('без username идём через импорт телефона', () => {
    expect(chooseResolutionStrategy({ tg_username: null, phone: '+998 90 111-22-33' }))
      .toEqual({ kind: 'phone', phone: '998901112233' });
  });

  it('пустые строки не считаются значением', () => {
    expect(chooseResolutionStrategy({ tg_username: '  ', phone: '' }))
      .toEqual({ kind: 'none' });
  });

  it('нет ни того ни другого — резолвить нечем', () => {
    expect(chooseResolutionStrategy({ tg_username: null, phone: null }))
      .toEqual({ kind: 'none' });
  });

  it('@ в начале username отбрасывается', () => {
    expect(chooseResolutionStrategy({ tg_username: '@ivan', phone: null }))
      .toEqual({ kind: 'username', username: 'ivan' });
  });

  it('normalizePhone оставляет только цифры', () => {
    expect(normalizePhone('+998 (90) 111-22-33')).toBe('998901112233');
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd app && npx jest tests/lib/tgOutreach/warmupPeer.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализация**

```ts
/**
 * Прогрев: как аккаунт находит другой наш аккаунт.
 *
 * Боевой цикл никогда не пишет первым — он отвечает на существующие диалоги,
 * где peer приходит готовым из getDialogs. Прогреву нужен первый контакт, а для
 * него нужен peer с access_hash. Два пути: резолв по @username (дёшево, ничего
 * не меняет в аккаунте) и импорт телефона в контакты (работает всегда, но
 * оставляет след).
 *
 * Импортированный контакт удаляем сразу после первого сообщения: диалог
 * остаётся рабочим, а постоянная взаимная сеть «все 16 аккаунтов друг у друга в
 * контактах» не образуется. Такой клубок — легко вычисляемый след, по одному
 * спалившемуся аккаунту находится вся партия.
 */
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import bigInt from 'big-integer';

export type ResolutionStrategy =
  | { kind: 'username'; username: string }
  | { kind: 'phone'; phone: string }
  | { kind: 'none' };

export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits : null;
}

export function chooseResolutionStrategy(target: {
  tg_username: string | null;
  phone: string | null;
}): ResolutionStrategy {
  const username = (target.tg_username ?? '').trim().replace(/^@/, '');
  if (username) return { kind: 'username', username };
  const phone = normalizePhone(target.phone);
  if (phone) return { kind: 'phone', phone };
  return { kind: 'none' };
}

export interface ResolvedPeer {
  entity: Api.User;
  /** Заполнено, если пришлось импортировать контакт — его надо удалить после отправки. */
  importedUserId: number | null;
}

/** Найти peer нашего же аккаунта, чтобы можно было ему написать. */
export async function resolveWarmupPeer(
  client: TelegramClient,
  target: { tg_username: string | null; phone: string | null },
): Promise<ResolvedPeer | null> {
  const strategy = chooseResolutionStrategy(target);
  if (strategy.kind === 'none') return null;

  if (strategy.kind === 'username') {
    const entity = await client.getEntity(strategy.username);
    return entity instanceof Api.User ? { entity, importedUserId: null } : null;
  }

  const clientId = bigInt(Date.now());
  const res = await client.invoke(new Api.contacts.ImportContacts({
    contacts: [new Api.InputPhoneContact({
      clientId: clientId as unknown as never,
      phone: strategy.phone,
      firstName: 'Kolya',
      lastName: '',
    })],
  }));
  const user = res.users.find((u): u is Api.User => u instanceof Api.User);
  if (!user) return null;
  return { entity: user, importedUserId: Number(user.id) };
}

/** Убрать импортированный контакт. Диалог при этом остаётся доступным. */
export async function dropImportedContact(
  client: TelegramClient,
  entity: Api.User,
): Promise<void> {
  await client.invoke(new Api.contacts.DeleteContacts({ id: [entity] }));
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd app && npx jest tests/lib/tgOutreach/warmupPeer.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/peer.ts app/tests/lib/tgOutreach/warmupPeer.test.ts
git commit -m "feat(tg-outreach): резолв собеседника для прогрева"
```

---

## Task 8: Bootstrap личности аккаунта

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/identity.ts`

- [ ] **Step 1: Написать файл**

```ts
/**
 * Прогрев: узнать, кто такой сам аккаунт.
 *
 * В tg_outreach_accounts нет ни tg_user_id, ни username — боевому циклу они не
 * нужны, он всегда отвечает уже известному собеседнику. Прогреву нужны: чтобы А
 * написал Б, надо знать, как Б адресовать.
 */
import type { TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Api } from 'telegram';
import { normalizePhone } from './peer';

export interface AccountIdentity {
  tg_user_id: number | null;
  tg_username: string | null;
  phone: string | null;
}

/**
 * Спросить у Telegram, кто мы, и сохранить в БД. Телефон записываем только
 * если в БД его ещё нет: в аккаунтах он часто пустой, а getMe его знает.
 */
export async function bootstrapAccountIdentity(
  db: SupabaseClient,
  client: TelegramClient,
  account: { id: string; phone: string | null },
): Promise<AccountIdentity> {
  const me = await client.getMe();
  const user = me as Api.User;

  const identity: AccountIdentity = {
    tg_user_id: user?.id != null ? Number(user.id) : null,
    tg_username: user?.username ?? null,
    phone: normalizePhone(account.phone) ?? normalizePhone(user?.phone ?? null),
  };

  const patch: Record<string, unknown> = {
    tg_user_id: identity.tg_user_id,
    tg_username: identity.tg_username,
    identity_checked_at: new Date().toISOString(),
  };
  if (!normalizePhone(account.phone) && identity.phone) patch.phone = identity.phone;

  await db.from('tg_outreach_accounts').update(patch).eq('id', account.id);
  return identity;
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/identity.ts
git commit -m "feat(tg-outreach): bootstrap личности аккаунта"
```

---

## Task 9: Слой БД прогрева

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/db.ts`

- [ ] **Step 1: Написать файл**

```ts
/**
 * Прогрев: работа с БД. Всё состояние живёт здесь, а не в памяти воркера —
 * четыре дня гарантированно переживут несколько перезапусков (деплой,
 * сторожевой таймер на 15 минут простоя), и прогрев обязан продолжаться с той
 * же точки.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  WarmupConversation,
  WarmupRun,
  WarmupSummary,
} from './types';
import { CONVERSATION_STALE_MINUTES } from './types';
import type { PlannedConversation } from './schedule';

export async function getActiveRun(
  db: SupabaseClient,
  campaignId: string,
): Promise<WarmupRun | null> {
  const { data } = await db
    .from('tg_outreach_warmup_runs')
    .select('*')
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'running'])
    .maybeSingle();
  return (data as WarmupRun | null) ?? null;
}

export async function getLatestRun(
  db: SupabaseClient,
  campaignId: string,
): Promise<WarmupRun | null> {
  const { data } = await db
    .from('tg_outreach_warmup_runs')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as WarmupRun | null) ?? null;
}

export async function createRun(
  db: SupabaseClient,
  campaignId: string,
  days: number,
  settings: Record<string, unknown>,
): Promise<WarmupRun | null> {
  const { data } = await db
    .from('tg_outreach_warmup_runs')
    .insert({ campaign_id: campaignId, days, settings, status: 'pending' })
    .select('*')
    .maybeSingle();
  return (data as WarmupRun | null) ?? null;
}

export async function setRunStatus(
  db: SupabaseClient,
  runId: string,
  patch: Partial<Pick<WarmupRun, 'status' | 'current_day' | 'error_message'>> & {
    started_at?: string;
    finished_at?: string;
    summary?: WarmupSummary;
  },
): Promise<void> {
  await db.from('tg_outreach_warmup_runs').update(patch).eq('id', runId);
}

/** Сохранить план дня. Дубли пары внутри дня отсекает уникальный индекс. */
export async function saveDayPlan(
  db: SupabaseClient,
  run: WarmupRun,
  day: number,
  plan: PlannedConversation[],
): Promise<void> {
  if (!plan.length) return;
  await db.from('tg_outreach_warmup_conversations').upsert(
    plan.map((c) => ({
      run_id: run.id,
      campaign_id: run.campaign_id,
      day_no: day,
      account_a_id: c.accountAId,
      account_b_id: c.accountBId,
      initiator_account_id: c.initiatorAccountId,
      planned_at: c.plannedAt,
      planned_messages: c.plannedMessages,
      status: 'pending',
    })),
    { onConflict: 'run_id,day_no,account_a_id,account_b_id', ignoreDuplicates: true },
  );
}

export async function isDayPlanned(
  db: SupabaseClient,
  runId: string,
  day: number,
): Promise<boolean> {
  const { count } = await db
    .from('tg_outreach_warmup_conversations')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('day_no', day);
  return (count ?? 0) > 0;
}

/** Пары, которые уже общались в этом прогреве — вход для планировщика. */
export async function loadPreviousPairs(
  db: SupabaseClient,
  runId: string,
): Promise<Array<[string, string]>> {
  const { data } = await db
    .from('tg_outreach_warmup_conversations')
    .select('account_a_id, account_b_id')
    .eq('run_id', runId);
  return ((data ?? []) as Array<{ account_a_id: string; account_b_id: string }>).map(
    (r) => [r.account_a_id, r.account_b_id] as [string, string],
  );
}

/**
 * Переписки, которым пора начаться. Сюда же возвращаются зависшие в running:
 * если процесс умер посреди переписки, она иначе осталась бы в running навсегда.
 */
export async function loadDueConversations(
  db: SupabaseClient,
  runId: string,
  day: number,
  now: Date,
): Promise<WarmupConversation[]> {
  const staleBefore = new Date(now.getTime() - CONVERSATION_STALE_MINUTES * 60_000).toISOString();
  const { data } = await db
    .from('tg_outreach_warmup_conversations')
    .select('*')
    .eq('run_id', runId)
    .eq('day_no', day)
    .lte('planned_at', now.toISOString())
    .or(`status.eq.pending,and(status.eq.running,started_at.lt.${staleBefore})`)
    .order('planned_at', { ascending: true })
    .limit(50);
  return (data ?? []) as WarmupConversation[];
}

export async function markConversationRunning(
  db: SupabaseClient,
  id: number,
): Promise<void> {
  await db
    .from('tg_outreach_warmup_conversations')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', id);
}

export async function finishConversation(
  db: SupabaseClient,
  id: number,
  result: { status: 'done' | 'failed' | 'skipped'; messages?: unknown[]; errorReason?: string },
): Promise<void> {
  await db
    .from('tg_outreach_warmup_conversations')
    .update({
      status: result.status,
      finished_at: new Date().toISOString(),
      ...(result.messages ? { messages: result.messages } : {}),
      ...(result.errorReason ? { error_reason: result.errorReason } : {}),
    })
    .eq('id', id);
}

/** Пометить все несделанные переписки дня пропущенными (день кончился). */
export async function skipRemainingForDay(
  db: SupabaseClient,
  runId: string,
  day: number,
  reason: string,
): Promise<void> {
  await db
    .from('tg_outreach_warmup_conversations')
    .update({ status: 'skipped', error_reason: reason, finished_at: new Date().toISOString() })
    .eq('run_id', runId)
    .eq('day_no', day)
    .in('status', ['pending', 'running']);
}

export async function buildSummary(
  db: SupabaseClient,
  run: WarmupRun,
  accounts: Array<{ id: string; session_name: string }>,
): Promise<WarmupSummary> {
  const { data } = await db
    .from('tg_outreach_warmup_conversations')
    .select('account_a_id, account_b_id, status, messages, error_reason')
    .eq('run_id', run.id);
  const rows = (data ?? []) as Array<{
    account_a_id: string; account_b_id: string; status: string;
    messages: unknown[]; error_reason: string | null;
  }>;

  const per = new Map(accounts.map((a) => [a.id, {
    account_id: a.id, session_name: a.session_name,
    done: 0, failed: 0, last_error: null as string | null,
  }]));

  let done = 0, failed = 0, messages = 0;
  for (const r of rows) {
    if (r.status === 'done') { done++; messages += (r.messages ?? []).length; }
    else if (r.status === 'failed') failed++;
    for (const id of [r.account_a_id, r.account_b_id]) {
      const slot = per.get(id);
      if (!slot) continue;
      if (r.status === 'done') slot.done++;
      else if (r.status === 'failed') {
        slot.failed++;
        if (r.error_reason) slot.last_error = r.error_reason;
      }
    }
  }

  const perAccount = [...per.values()];
  return {
    accounts_total: accounts.length,
    accounts_ok: perAccount.filter((a) => a.done > 0 && a.failed === 0).length,
    accounts_failed: perAccount.filter((a) => a.done === 0 && a.failed > 0).length,
    conversations_done: done,
    conversations_failed: failed,
    messages_sent: messages,
    per_account: perAccount,
  };
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/db.ts
git commit -m "feat(tg-outreach): слой БД прогрева"
```

---

## Task 10: Цикл прогрева

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/loop.ts`

Цикл переиспользует `buildClients`/`disconnectAll` из `gramClient.ts` и пишет логи в `tg_outreach_logs` с `account_id`.

- [ ] **Step 1: Написать файл**

```ts
/**
 * Прогрев: главный цикл.
 *
 * Держится на состоянии в БД, а не в памяти: за 4 дня процесс гарантированно
 * перезапустится (деплой, watchdog на 15 минут простоя). Каждый проход —
 * «какой сейчас день → есть ли план → какие переписки пора провести».
 *
 * Прогрев и боевой цикл кампании взаимоисключающие, поэтому оба свободно пишут
 * в общий cooldown_until без конфликта.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { Api } from 'telegram';
import type { OutreachAccount, OutreachCampaign, OutreachProxy, TelegramSettings } from '../types';
import { buildClients, disconnectAll, type ActiveClient } from '../gramClient';
import { openaiGenerate } from '../openaiChat';
import { planDay } from './schedule';
import { warmupOpenAISettings } from './prompt';
import { runWarmupConversation, type WarmupSide } from './conversation';
import { resolveWarmupPeer, dropImportedContact } from './peer';
import { bootstrapAccountIdentity } from './identity';
import * as wdb from './db';
import type { WarmupRun } from './types';

const POLL_INTERVAL_MS = 60_000;

type LogFn = (level: 'info' | 'warning' | 'error', msg: string, accountId?: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !shouldStop()) {
    await sleep(Math.min(2000, end - Date.now()));
  }
}

/** Активное окно суток по sleep_periods кампании (в UTC). */
export function activeWindowForDay(now: Date, tg: TelegramSettings): { start: Date; end: Date } {
  const offset = tg.timezone_offset ?? 3;
  const periods = tg.sleep_periods ?? ['00:00-08:00'];
  const first = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(periods[0] ?? '00:00-08:00');
  const wakeHour = first ? Number(first[3]) : 8;
  const sleepHour = first ? Number(first[1]) : 0;

  const start = new Date(now);
  start.setUTCHours(wakeHour - offset, 0, 0, 0);
  const end = new Date(start);
  const activeHours = ((sleepHour - wakeHour) + 24) % 24 || 16;
  end.setUTCHours(start.getUTCHours() + activeHours, 0, 0, 0);
  if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function dayNumber(run: WarmupRun, now: Date): number {
  if (!run.started_at) return 1;
  const started = new Date(run.started_at);
  const days = Math.floor((now.getTime() - started.getTime()) / (24 * 3600 * 1000));
  return Math.min(days + 1, run.days);
}

export async function runWarmupLoop(
  campaignId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
  onProgress?: () => void,
): Promise<void> {
  const log: LogFn = (level, message, accountId) => {
    void db.from('tg_outreach_logs')
      .insert({ campaign_id: campaignId, level, message, account_id: accountId ?? null })
      .then(() => {});
  };

  const run = await wdb.getActiveRun(db, campaignId);
  if (!run) {
    log('warning', 'Прогрев: активного запуска нет — нечего выполнять.');
    return;
  }

  const { data: campaignRow } = await db
    .from('tg_outreach_campaigns').select('*').eq('id', campaignId).maybeSingle();
  const campaign = campaignRow as OutreachCampaign | null;
  if (!campaign) {
    await wdb.setRunStatus(db, run.id, { status: 'failed', error_message: 'campaign_not_found' });
    return;
  }
  const tg = campaign.telegram_settings as TelegramSettings;

  const { data: accountRows } = await db
    .from('tg_outreach_accounts').select('*').eq('campaign_id', campaignId).eq('is_active', true);
  const accounts = (accountRows ?? []) as OutreachAccount[];
  if (accounts.length < 2) {
    await wdb.setRunStatus(db, run.id, { status: 'failed', error_message: 'need_at_least_two_accounts' });
    log('error', 'Прогрев: нужно минимум два активных аккаунта.');
    return;
  }

  const { data: proxyRows } = await db
    .from('tg_outreach_proxies').select('*').eq('campaign_id', campaignId).eq('is_active', true);
  const proxies = (proxyRows ?? []) as OutreachProxy[];

  const clients = await buildClients(accounts, proxies, (lvl, msg) => log(lvl, msg), undefined, db);
  if (clients.length < 2) {
    await disconnectAll(clients);
    await wdb.setRunStatus(db, run.id, { status: 'failed', error_message: 'not_enough_clients' });
    log('error', `Прогрев: подключились только ${clients.length} аккаунтов из ${accounts.length} — прогревать не с кем.`);
    return;
  }

  const byAccountId = new Map<string, ActiveClient>(clients.map((c) => [c.account.id, c]));

  if (run.status === 'pending') {
    await wdb.setRunStatus(db, run.id, { status: 'running', started_at: new Date().toISOString(), current_day: 1 });
    run.started_at = new Date().toISOString();
    run.status = 'running';
    log('info', `Прогрев начат: ${run.days} дней, ${clients.length} аккаунтов.`);
  }

  for (const c of clients) {
    if (shouldStop()) break;
    try {
      await bootstrapAccountIdentity(db, c.client, c.account);
    } catch (e) {
      log('warning', `Прогрев: не смог определить личность аккаунта — ${e instanceof Error ? e.message : String(e)}`, c.account.id);
    }
  }

  try {
    while (!shouldStop()) {
      onProgress?.();
      const now = new Date();
      const day = dayNumber(run, now);

      const fresh = await wdb.getActiveRun(db, campaignId);
      if (!fresh || fresh.status === 'stopped') break;

      if (day > run.days) {
        const summary = await wdb.buildSummary(db, run, accounts.map((a) => ({ id: a.id, session_name: a.session_name })));
        await wdb.setRunStatus(db, run.id, {
          status: 'finished', finished_at: new Date().toISOString(), current_day: run.days, summary,
        });
        log('info', `Прогрев завершён: ${summary.conversations_done} переписок, ${summary.messages_sent} сообщений, аккаунтов с проблемами — ${summary.accounts_failed}.`);
        break;
      }

      if (fresh.current_day !== day) {
        await wdb.setRunStatus(db, run.id, { current_day: day });
      }

      if (!(await wdb.isDayPlanned(db, run.id, day))) {
        const previousPairs = await wdb.loadPreviousPairs(db, run.id);
        const plan = planDay({
          accountIds: [...byAccountId.keys()],
          day,
          totalDays: run.days,
          previousPairs,
          window: activeWindowForDay(now, tg),
          random: Math.random,
        });
        await wdb.saveDayPlan(db, run, day, plan);
        log('info', `Прогрев: день ${day} из ${run.days}, запланировано ${plan.length} переписок.`);
      }

      const due = await wdb.loadDueConversations(db, run.id, day, now);
      for (const conv of due) {
        if (shouldStop()) break;
        onProgress?.();
        await runOneConversation(db, conv, byAccountId, log);
      }

      await interruptibleSleep(POLL_INTERVAL_MS, shouldStop);
    }
  } finally {
    await disconnectAll(clients);
  }
}

async function runOneConversation(
  db: SupabaseClient,
  conv: { id: number; account_a_id: string; account_b_id: string; initiator_account_id: string; planned_messages: number },
  byAccountId: Map<string, ActiveClient>,
  log: LogFn,
): Promise<void> {
  const a = byAccountId.get(conv.account_a_id);
  const b = byAccountId.get(conv.account_b_id);
  if (!a || !b) {
    await wdb.finishConversation(db, conv.id, { status: 'failed', errorReason: 'account_not_connected' });
    return;
  }

  await wdb.markConversationRunning(db, conv.id);

  let peerForA: Awaited<ReturnType<typeof resolveWarmupPeer>> = null;
  let peerForB: Awaited<ReturnType<typeof resolveWarmupPeer>> = null;
  try {
    peerForA = await resolveWarmupPeer(a.client, {
      tg_username: (b.account as { tg_username?: string | null }).tg_username ?? null,
      phone: b.account.phone ?? null,
    });
    peerForB = await resolveWarmupPeer(b.client, {
      tg_username: (a.account as { tg_username?: string | null }).tg_username ?? null,
      phone: a.account.phone ?? null,
    });
  } catch (e) {
    await wdb.finishConversation(db, conv.id, {
      status: 'failed', errorReason: `resolve_failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    log('warning', `Прогрев: не смог найти собеседника — ${e instanceof Error ? e.message : String(e)}`, a.account.id);
    return;
  }
  if (!peerForA || !peerForB) {
    await wdb.finishConversation(db, conv.id, { status: 'failed', errorReason: 'peer_not_resolvable' });
    return;
  }

  const sideA: WarmupSide = {
    accountId: a.account.id,
    send: async (text) => { await a.client.sendMessage(peerForA!.entity, { message: text }); },
  };
  const sideB: WarmupSide = {
    accountId: b.account.id,
    send: async (text) => { await b.client.sendMessage(peerForB!.entity, { message: text }); },
  };

  const settings = warmupOpenAISettings();
  try {
    const messages = await runWarmupConversation({
      sideA, sideB,
      initiatorAccountId: conv.initiator_account_id,
      plannedMessages: conv.planned_messages,
      generate: (history) => openaiGenerate(settings, history),
      sleep,
      random: Math.random,
    });
    await wdb.finishConversation(db, conv.id, { status: 'done', messages });
  } catch (e) {
    await wdb.finishConversation(db, conv.id, {
      status: 'failed', errorReason: e instanceof Error ? e.message : String(e),
    });
    log('warning', `Прогрев: переписка не состоялась — ${e instanceof Error ? e.message : String(e)}`, a.account.id);
  } finally {
    for (const [client, peer] of [[a.client, peerForA], [b.client, peerForB]] as const) {
      if (peer?.importedUserId != null) {
        try { await dropImportedContact(client, peer.entity); } catch { /* контакт мог не создаться */ }
      }
    }
  }
}

export { Api };
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/tgOutreach/warmup/loop.ts
git commit -m "feat(tg-outreach): цикл прогрева"
```

---

## Task 11: Действия воркера

**Files:**
- Modify: `app/worker/tgOutreach.ts:49-50` (списки действий), `:199-231` (диспетчер)

- [ ] **Step 1: Добавить действия**

В константы действий добавить `warmup_start` в START_ACTIONS и `warmup_stop` в CONTROL_ACTIONS:

```ts
const CONTROL_ACTIONS = ['stop', 'restart', 'refetch_messages', 'warmup_stop'] as const;
const START_ACTIONS = ['start', 'warmup_start'] as const;
```

- [ ] **Step 2: Ветка диспетчера**

В `dispatchJob` добавить ветки:

```ts
if (job.action === 'warmup_start') return handleWarmupStartJob(job);
if (job.action === 'warmup_stop') return handleWarmupStopJob(job);
```

И обработчики по образцу `handleStartJob`/`handleStopJob`, но вызывающие `runWarmupLoop` из `@/lib/tgOutreach/warmup/loop` и ставящие `tg_outreach_warmup_runs.status='stopped'` при остановке. Прогрев регистрируется в том же `runningCampaigns`, чтобы кампания не могла одновременно греться и работать по лидам.

- [ ] **Step 3: Проверить типы и собрать воркер**

Run: `cd app && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 4: Коммит**

```bash
git add app/worker/tgOutreach.ts
git commit -m "feat(tg-outreach): действия прогрева в воркере"
```

---

## Task 12: API прогрева

**Files:**
- Create: `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/route.ts`
- Create: `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/conversations/route.ts`
- Modify: `app/src/app/api/tools/tg-outreach/campaigns/[id]/logs/route.ts`

- [ ] **Step 1: Роут статуса и управления**

`GET` возвращает последний run + агрегаты по дням и аккаунтам. `POST {days}` отказывает с 409, если кампания `running` или уже есть активный прогрев, иначе создаёт run и job `warmup_start`. `DELETE` ставит job `warmup_stop`.

Оба используют `authenticateRequest` и `withToolTrace` по образцу `campaigns/[id]/start/route.ts`.

- [ ] **Step 2: Роут переписок**

`GET ?account_id=&day=` — список переписок кампании с фильтром; сортировка по `planned_at desc`, лимит 200.

- [ ] **Step 3: Фильтр логов по аккаунту**

В существующий logs-роут добавить: `if (accountId) q = q.eq('account_id', accountId)`.

- [ ] **Step 4: Проверить типы**

Run: `cd app && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 5: Коммит**

```bash
git add app/src/app/api/tools/tg-outreach/campaigns/
git commit -m "feat(tg-outreach): API прогрева"
```

---

## Task 13: Вкладка «Прогрев»

**Files:**
- Create: `app/src/components/tg-outreach/WarmupTab.tsx`
- Modify: `app/src/app/tools/tg-outreach/page.tsx:2054-2059`

Раскладка согласована с заказчиком: полоса управления → метрики → двухколоночная область (аккаунты слева, переписки справа) → логи снизу. Выбор аккаунта слева фильтрует одновременно переписки и логи.

- [ ] **Step 1: Компонент**

Пропсы: `{ campaignId: string; isOwn: boolean }`. Состояние: `run`, `conversations`, `logs`, `selectedAccountId`, `days`. Поллинг статуса раз в 10 секунд, пока `status==='running'`.

Блоки:
1. Полоса управления: статус «день N из M», `input[type=number]` дней (disabled во время прогрева), кнопка «Начать прогрев» / «Остановить», полоса прогресса по дням.
2. Метрики: аккаунтов, переписок сегодня, сообщений всего, с проблемами.
3. Список аккаунтов: имя, «сделано из запланированного», цветной статус с причиной.
4. Переписки выбранного аккаунта: строка раскрывается, показывая `messages` из строки БД.
5. Логи: фильтр по выбранному аккаунту, кнопки «Все события» / «Только ошибки».

- [ ] **Step 2: Подключить вкладку**

В список табов добавить `warmup` с подписью «Прогрев», рендерить `<WarmupTab campaignId={c.id} isOwn={isOwn} />`.

- [ ] **Step 3: Проверить типы и линт**

Run: `cd app && npx tsc --noEmit && npx eslint src/components/tg-outreach/WarmupTab.tsx`
Expected: без ошибок

- [ ] **Step 4: Коммит**

```bash
git add app/src/components/tg-outreach/WarmupTab.tsx app/src/app/tools/tg-outreach/page.tsx
git commit -m "feat(tg-outreach): вкладка прогрева"
```

---

## Task 14: Боевой цикл игнорирует свои аккаунты

**Files:**
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts` (загрузка аккаунтов и фильтр диалогов)

Переписки прогрева не пишутся в `tg_outreach_dialogs`, но диалог с собственным аккаунтом всё равно всплывёт в `getDialogs` и попадёт в `handleChat` как лид.

- [ ] **Step 1: Собрать множество своих id**

После загрузки аккаунтов кампании:

```ts
const ownTgUserIds = new Set(
  accounts
    .map((a) => (a as { tg_user_id?: number | null }).tg_user_id)
    .filter((v): v is number => typeof v === 'number'),
);
```

- [ ] **Step 2: Пропускать их в цикле диалогов**

Рядом с проверкой `dialog.unreadCount === 0`:

```ts
if (ownTgUserIds.has(Number(dialog.entity.id))) {
  cycleStats.own_account = (cycleStats.own_account ?? 0) + 1;
  continue;
}
```

- [ ] **Step 3: Проверить типы и прогнать тесты цикла**

Run: `cd app && npx tsc --noEmit && npx jest tests/lib/tgOutreachHandleChat.test.ts`
Expected: без ошибок, тесты проходят

- [ ] **Step 4: Коммит**

```bash
git add app/src/lib/tgOutreach/campaignLoop.ts
git commit -m "feat(tg-outreach): боевой цикл пропускает собственные аккаунты"
```

---

## Task 15: Финальная проверка

- [ ] **Step 1: Прогнать все тесты tg-outreach**

Run: `cd app && npx jest tests/lib/tgOutreach tests/lib/tgOutreachProxyHealth.test.ts tests/lib/tgOutreachHandleChat.test.ts tests/lib/tgOutreachClaimJob.test.ts`
Expected: все PASS

- [ ] **Step 2: Типы и линт по всему изменённому**

Run: `cd app && npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Обновить спеку статусом**

В `docs/superpowers/specs/2026-08-03-tg-outreach-warmup-design.md` пометить, что реализовано, и что осталось (прокси-пул — вне кода).

- [ ] **Step 4: Коммит и пуш в текущую ветку**

```bash
git push origin dmitriy_kuladmed
```
