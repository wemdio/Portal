# Дашборд первички, этап 1 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница `/analytics/first-sales` с лидами по источникам, встречами, договорами и средним циклом — с диапазоном дат, фильтром по каналам и группировкой по дням / неделям / месяцам.

**Architecture:** Историю переходов по этапам забирает новый источник в существующем Python-синке в таблицу `amo_events`. Поверх неё SQL-view считает, когда сделка впервые дошла до каждого этапа. Свёртка «источник AMO → канал продаж» живёт в редактируемой таблице `lead_source_channels`. Расчёт метрик — чистые TypeScript-функции в `src/lib/firstSales/`, вызываются из API-роутов под серверным гардом; страница на React + recharts.

**Tech Stack:** Next.js 16 / React 19, TypeScript, Tailwind 4, Supabase (Postgres), Jest, recharts; Python 3 + asyncpg + httpx для синка.

Спека: [`docs/superpowers/specs/2026-07-30-first-sales-dashboard-design.md`](../specs/2026-07-30-first-sales-dashboard-design.md)

---

## Отклонение от спеки (осознанное)

Спека предписывала производную **таблицу** `amo_lead_stage_dates` с пересчётом после каждого синка. План делает **view** `amo_lead_stage_dates_v`.

Причина: ожидаемый объём событий — 30–60 тыс. строк, группировка по ним занимает единицы миллисекунд. Таблица потребовала бы шага пересчёта, умела бы протухать при сбое синка и размазала бы правило «проскок этапа засчитывается» между SQL и Python. View держит правило в одном определении и протухнуть не может.

Следствие: у `AmoEventsSync` остаётся одна фаза вместо двух.

Второе уточнение: `won_at` берётся из `amo_leads.closed_at`, который синкается с 2024 года, а не из событий. Поэтому **средний цикл считается за всю историю независимо от глубины событий AMO**.

Третье: спека перечисляла отдельный роут `/sources` для разбивки по источникам. Он схлопнут в `/summary` — обе цифры считаются из одной и той же выборки сделок, и разделение означало бы два одинаковых тяжёлых запроса вместо одного. Роутов остаётся три: `summary`, `leads`, `source-map`.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260730_0001_first_sales_dashboard.sql` | Таблица `lead_source_channels`, view `amo_lead_stage_dates_v`, индексы на `amo_events`, RLS, гранты, сид справочника |
| `app/scripts/amo-events-probe.mjs` | Разовый спайк: глубина истории в AMO |
| `app/scripts/backfill-amo-events.mjs` | Разовый бэкфилл событий за всю доступную глубину |
| `app/scripts/verify-stage-dates.mjs` | Проверка view на боевых данных: проскок этапа, сделки без событий |
| `app/scripts/first-sales-reconcile.mjs` | Сверка с логикой отчёта продаж |
| `services/portal-external-sync/sources/amo_events.py` | Ночной инкрементальный забор событий |
| `app/src/lib/firstSales/sourceChannels.ts` | Нормализация значения «Источник», свёртка в канал |
| `app/src/lib/firstSales/buckets.ts` | Границы дня / недели / месяца в МСК, раскладка по корзинам |
| `app/src/lib/firstSales/params.ts` | Разбор и валидация параметров запроса, предыдущее окно для Δ |
| `app/src/lib/firstSales/metrics.ts` | Чистый расчёт метрик по строкам + запросы к БД |
| `app/src/lib/firstSales/access.ts` | Гард `requireFirstSalesAccess` |
| `app/src/app/api/analytics/first-sales/summary/route.ts` | KPI, Δ к предыдущему периоду, ряды по времени, разбивка по источникам |
| `app/src/app/api/analytics/first-sales/leads/route.ts` | Drill-down: сделки источника со ссылками в AMO |
| `app/src/app/api/analytics/first-sales/source-map/route.ts` | Чтение и правка справочника |
| `app/src/app/analytics/first-sales/page.tsx` | Страница-контейнер |
| `app/src/components/first-sales/*` | Шапка фильтров, KPI, графики, таблицы, экран справочника |
| `app/src/lib/toolsRegistry.ts` | `nav-first-sales` в реестре вкладок, флаг `adminAlwaysOn` |
| `app/src/lib/navigation.ts` | Пункт меню «Первичка» |

---

## Task 1: Спайк — глубина истории в AMO

Ничего не строим, пока не знаем, за какой период AMO отдаёт события смены этапа. Результат меняет обещание пользователю, но не архитектуру.

**Files:**
- Create: `app/scripts/amo-events-probe.mjs`

- [ ] **Step 1: Написать скрипт-пробу**

```javascript
// app/scripts/amo-events-probe.mjs
// Разовая проба: за какой период AMO отдаёт события смены этапа сделки.
// Запуск: node scripts/amo-events-probe.mjs
import 'dotenv/config';

const TOKEN = (process.env.AMO_ACCESS_TOKEN || process.env.AMOCRM_TOKEN || '').trim();
const BASE = (process.env.AMO_BASE_URL || '').trim().replace(/\/$/, '');

if (!TOKEN || !BASE) {
  console.error('Нужны AMO_ACCESS_TOKEN и AMO_BASE_URL в .env');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}` };

async function get(url) {
  const res = await fetch(url, { headers });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

// 1. Есть ли вообще эндпоинт и какие типы событий приходят
const probe = await get(`${BASE}/api/v4/events?limit=1`);
console.log('эндпоинт отвечает:', probe ? 'да' : 'пусто');

// 2. Самое старое событие смены этапа: сортировка по возрастанию не поддержана,
//    поэтому идём бинарно по фильтру created_at[from].
const YEAR = 365 * 24 * 3600;
const now = Math.floor(Date.now() / 1000);

async function hasEventsSince(fromUnix) {
  const url =
    `${BASE}/api/v4/events?limit=1` +
    `&filter[type][]=lead_status_changed` +
    `&filter[created_at][from]=${fromUnix}` +
    `&filter[created_at][to]=${fromUnix + 30 * 24 * 3600}`;
  const data = await get(url);
  return Boolean(data?._embedded?.events?.length);
}

for (const yearsBack of [0, 1, 2, 3]) {
  const from = now - Math.round(yearsBack * YEAR) - 30 * 24 * 3600;
  const iso = new Date(from * 1000).toISOString().slice(0, 10);
  let ok = false;
  try {
    ok = await hasEventsSince(from);
  } catch (e) {
    console.log(`  ${iso}: ОШИБКА ${e.message}`);
    continue;
  }
  console.log(`  ${iso}: ${ok ? 'события есть' : 'событий нет'}`);
}

// 3. Форма одного события — что именно писать в amo_events
const sample = await get(
  `${BASE}/api/v4/events?limit=1&filter[type][]=lead_status_changed`,
);
const ev = sample?._embedded?.events?.[0];
console.log('\nобразец события:');
console.log(JSON.stringify(ev, null, 2));
```

- [ ] **Step 2: Запустить пробу**

```bash
cd app && node scripts/amo-events-probe.mjs
```

Ожидаемо: строка «эндпоинт отвечает: да», затем четыре строки по годам с «события есть» / «событий нет», затем JSON одного события с полями `type`, `entity_id`, `created_at`, `value_before`, `value_after`.

Если эндпоинт отвечает 403 — у токена нет права на события; это блокер, остановиться и сообщить.

- [ ] **Step 3: Записать результат в спеку**

В `docs/superpowers/specs/2026-07-30-first-sales-dashboard-design.md`, раздел «Открытые вопросы», пункт 2 «Глубина истории в AMO» — заменить на найденный факт, например: «Глубина: события смены этапа доступны с 2025-03. Сделки, созданные раньше, помечаются `history_complete = false`.»

- [ ] **Step 4: Закоммитить**

```bash
git add app/scripts/amo-events-probe.mjs docs/superpowers/specs/2026-07-30-first-sales-dashboard-design.md
git commit -m "chore(first-sales): проба глубины истории событий AMO"
```

---

## Task 2: Миграция — справочник источников и view дат этапов

**Files:**
- Create: `supabase/migrations/20260730_0001_first_sales_dashboard.sql`
- Test: `app/tests/migrations/firstSalesDashboard.test.ts`

- [ ] **Step 1: Написать падающий тест схемы**

```typescript
// app/tests/migrations/firstSalesDashboard.test.ts
import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../supabase/migrations/20260730_0001_first_sales_dashboard.sql',
  ),
  'utf8',
);

describe('миграция дашборда первички', () => {
  it('создаёт справочник источников', () => {
    expect(SQL).toMatch(/create table if not exists public\.lead_source_channels/);
    expect(SQL).toMatch(/unique/i);
  });

  it('ограничивает канал списком значений', () => {
    for (const channel of [
      'marketing', 'smm', 'outreach', 'partners',
      'tg_outreach', 'inbound', 'referral', 'events', 'unassigned',
    ]) {
      expect(SQL).toContain(`'${channel}'`);
    }
  });

  it('создаёт view дат этапов', () => {
    expect(SQL).toMatch(/create or replace view public\.amo_lead_stage_dates_v/);
  });

  it('выдаёт гранты service_role на новую таблицу', () => {
    expect(SQL).toMatch(/grant all on public\.lead_source_channels\s+to service_role/);
  });

  it('включает RLS без select-политики для authenticated', () => {
    expect(SQL).toMatch(
      /alter table public\.lead_source_channels\s+enable row level security/,
    );
    expect(SQL).not.toMatch(/create policy .* on public\.lead_source_channels for select/);
  });

  it('индексирует amo_events под запросы view', () => {
    expect(SQL).toMatch(/create index if not exists .* on public\.amo_events/);
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

```bash
cd app && npm test -- tests/migrations/firstSalesDashboard.test.ts
```

Ожидаемо: FAIL, `ENOENT: no such file or directory` на чтении миграции.

- [ ] **Step 3: Написать миграцию**

```sql
-- supabase/migrations/20260730_0001_first_sales_dashboard.sql
-- Дашборд первички, этап 1: справочник «источник → канал» и view дат этапов.
-- Спека: docs/superpowers/specs/2026-07-30-first-sales-dashboard-design.md

-- ─── Справочник свёртки источника в канал ────────────────────────────────

create table if not exists public.lead_source_channels (
  id           bigserial primary key,
  source       text not null,
  channel      text not null default 'unassigned'
                 check (channel in (
                   'marketing','smm','outreach','partners',
                   'tg_outreach','inbound','referral','events','unassigned'
                 )),
  display_name text,
  sort_order   integer not null default 100,
  updated_by   uuid,
  updated_at   timestamptz not null default now()
);

-- source хранится уже нормализованным (trim + lower + ё→е) — так же, как его
-- нормализует sourceChannels.ts. Уникальность именно по нормализованному
-- значению: в AMO «Партнер» и «партнер» — один и тот же источник.
create unique index if not exists uq_lead_source_channels_source
  on public.lead_source_channels(source);

comment on table public.lead_source_channels is
  'Свёртка значения поля «Источник» AMO в канал продаж. Редактируется в портале на /analytics/first-sales. Источник вне справочника трактуется как unassigned.';

-- Первичное наполнение — только бесспорное. Спорные источники (Лидскан, Сайт,
-- Сарафан, Конференция, SEO, Холодная база, TG-посев — 969 сделок за 2026)
-- сознательно заводятся как unassigned: их раскладку согласуют продажи.
insert into public.lead_source_channels (source, display_name, channel, sort_order) values
  ('email outreach',            'Email Outreach',            'outreach',    10),
  ('аутрич',                    'Аутрич',                    'outreach',    11),
  ('партнер',                   'Партнёр',                   'partners',    20),
  ('telegram outreach',         'Telegram Outreach',         'tg_outreach', 30),
  ('smm',                       'SMM',                       'smm',         40),
  ('личный бренд (инст /ютуб)', 'Личный бренд (инст/ютуб)',  'smm',         41),
  ('сайт',                      'Сайт',                      'unassigned',  50),
  ('лидскан',                   'Лидскан',                   'unassigned',  51),
  ('tg-посев',                  'TG-посев',                  'unassigned',  52),
  ('сарафан',                   'Сарафан',                   'unassigned',  53),
  ('телеграм',                  'Телеграм',                  'unassigned',  54),
  ('холодная база',             'Холодная база',             'unassigned',  55),
  ('конференция',               'Конференция',               'unassigned',  56),
  ('тг-канал',                  'ТГ-канал',                  'unassigned',  57),
  ('seo',                       'SEO',                       'unassigned',  58),
  ('тг бот',                    'ТГ Бот',                    'unassigned',  59),
  ('портал (outreachos)',       'Портал (outreachOS)',       'unassigned',  60),
  ('инст-посев',                'Инст-посев',                'unassigned',  61),
  ('бот',                       'Бот',                       'unassigned',  62),
  ('email-рассылка',            'Email-рассылка',            'unassigned',  63),
  ('внешние статьи',            'Внешние статьи',            'unassigned',  64),
  ('pr',                        'PR',                        'unassigned',  65)
on conflict (source) do nothing;

-- ─── Индексы под view ────────────────────────────────────────────────────

create index if not exists idx_amo_events_deal_type_changed
  on public.amo_events(amo_deal_id, event_type, changed_at);

-- ─── View дат достижения этапов ──────────────────────────────────────────

-- Правило: считаем не переход в конкретный статус, а ПЕРВЫЙ момент, когда
-- сделка оказалась на этапе не ниже порога. Менеджеры проскакивают этапы —
-- двигают сделку сразу в «Отправлен счет», минуя «Встреча проведена».
-- Буквальный подсчёт переходов в статус 70 такие встречи потеряет.
--
-- Сделка, СОЗДАННАЯ сразу на высоком этапе, события не порождает. Поэтому
-- начальный статус восстанавливаем из from_value первого события, а при полном
-- отсутствии событий — из текущего статуса сделки.
create or replace view public.amo_lead_stage_dates_v as
with horizon as (
  -- Дата, раньше которой событий у нас нет. Сделки, созданные до неё, могли
  -- иметь переходы, которых мы не видели.
  select min(changed_at) as first_event_at from public.amo_events
),
ev as (
  select
    e.amo_deal_id,
    e.changed_at,
    e.from_value,
    e.to_value,
    row_number() over (partition by e.amo_deal_id order by e.changed_at) as rn
  from public.amo_events e
  where e.event_type = 'lead_status_changed'
),
initial_status as (
  select
    l.amo_id as amo_deal_id,
    coalesce(
      (select nullif(ev.from_value, '')::bigint from ev
        where ev.amo_deal_id = l.amo_id and ev.rn = 1),
      l.status_id
    ) as status_id
  from public.amo_leads l
),
reached as (
  select
    ev.amo_deal_id,
    min(ev.changed_at) filter (where s.sort >= 40)  as ev_qualified_at,
    min(ev.changed_at) filter (where s.sort >= 70)  as ev_meeting_at,
    min(ev.changed_at) filter (where s.sort >= 100) as ev_invoice_at,
    min(ev.changed_at) filter (where s.sort >= 110) as ev_contract_at
  from ev
  join public.amo_leads l on l.amo_id = ev.amo_deal_id
  join public.amo_statuses s
    on s.pipeline_id = l.pipeline_id
   and s.status_id = nullif(ev.to_value, '')::bigint
  group by ev.amo_deal_id
)
select
  l.amo_id                                        as amo_deal_id,
  l.pipeline_id,
  l.created_at,
  case when init_s.sort >= 40  then l.created_at else r.ev_qualified_at end as first_qualified_at,
  case when init_s.sort >= 70  then l.created_at else r.ev_meeting_at   end as first_meeting_at,
  case when init_s.sort >= 100 then l.created_at else r.ev_invoice_at   end as first_invoice_at,
  case when init_s.sort >= 110 then l.created_at else r.ev_contract_at  end as first_contract_at,
  -- Дата оплаты берётся из closed_at, а не из событий: он синкается с 2024 года
  -- и достоверен для всей истории. Средний цикл поэтому не зависит от глубины
  -- событий AMO.
  case when l.status_id = 142 then l.closed_at end as won_at,
  (h.first_event_at is not null and l.created_at >= h.first_event_at) as history_complete
from public.amo_leads l
cross join horizon h
left join initial_status i on i.amo_deal_id = l.amo_id
left join public.amo_statuses init_s
       on init_s.pipeline_id = l.pipeline_id
      and init_s.status_id = i.status_id
left join reached r on r.amo_deal_id = l.amo_id;

comment on view public.amo_lead_stage_dates_v is
  'Когда сделка ВПЕРВЫЕ дошла до каждого этапа. Проскок этапа засчитывается. history_complete=false — сделка создана раньше глубины событий, её этапы считать нельзя.';

-- ─── RLS и гранты ────────────────────────────────────────────────────────

-- Select-политики для authenticated нет сознательно: данные читает только
-- серверный код под service_role через API-роуты с гардом доступа.
alter table public.lead_source_channels enable row level security;

grant all on public.lead_source_channels to service_role, postgres;
grant usage, select on sequence public.lead_source_channels_id_seq to service_role, postgres;
grant select on public.amo_lead_stage_dates_v to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.lead_source_channels, public.amo_lead_stage_dates_v to readonly';
  end if;
end $$;
```

- [ ] **Step 4: Запустить тесты — схема и grant-линт**

```bash
cd app && npm test -- tests/migrations/firstSalesDashboard.test.ts tests/migrations/grants.test.ts
```

Ожидаемо: оба PASS. `grants.test.ts` проверяет, что у каждой новой `create table public.X` есть `grant ... to service_role` — он и ловит забытый грант.

- [ ] **Step 5: Закоммитить**

```bash
git add supabase/migrations/20260730_0001_first_sales_dashboard.sql app/tests/migrations/firstSalesDashboard.test.ts
git commit -m "feat(first-sales): справочник источников и view дат этапов"
```

---

## Task 3: Свёртка источника в канал

**Files:**
- Create: `app/src/lib/firstSales/sourceChannels.ts`
- Test: `app/tests/lib/firstSales/sourceChannels.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```typescript
// app/tests/lib/firstSales/sourceChannels.test.ts
import {
  normalizeSource,
  resolveChannel,
  type SourceChannelRow,
} from '@/lib/firstSales/sourceChannels';

const map: SourceChannelRow[] = [
  { source: 'email outreach', channel: 'outreach', display_name: 'Email Outreach' },
  { source: 'партнер', channel: 'partners', display_name: 'Партнёр' },
  { source: 'сайт', channel: 'unassigned', display_name: 'Сайт' },
];

const raw = (fields: Record<string, string>) => ({
  custom_fields_values: Object.entries(fields).map(([field_name, value]) => ({
    field_name,
    values: [{ value }],
  })),
});

describe('normalizeSource', () => {
  it('обрезает пробелы и приводит к нижнему регистру', () => {
    expect(normalizeSource('  Email Outreach ')).toBe('email outreach');
  });

  it('схлопывает ё в е', () => {
    expect(normalizeSource('Партнёр')).toBe('партнер');
  });

  it('пустое значение даёт пустую строку', () => {
    expect(normalizeSource(null)).toBe('');
    expect(normalizeSource('   ')).toBe('');
  });
});

describe('resolveChannel', () => {
  it('находит канал по справочнику', () => {
    expect(resolveChannel(raw({ Источник: 'Email Outreach' }), map).channel)
      .toBe('outreach');
  });

  it('не зависит от регистра и ё', () => {
    expect(resolveChannel(raw({ Источник: 'ПАРТНЁР' }), map).channel)
      .toBe('partners');
  });

  it('источник вне справочника даёт unassigned, но сохраняет исходное значение', () => {
    const res = resolveChannel(raw({ Источник: 'Нейровыдача' }), map);
    expect(res.channel).toBe('unassigned');
    expect(res.source).toBe('нейровыдача');
    expect(res.known).toBe(false);
  });

  it('источник в справочнике со значением unassigned считается известным', () => {
    const res = resolveChannel(raw({ Источник: 'Сайт' }), map);
    expect(res.channel).toBe('unassigned');
    expect(res.known).toBe(true);
  });

  it('пустой источник даёт unassigned с пустым source', () => {
    const res = resolveChannel(raw({}), map);
    expect(res.channel).toBe('unassigned');
    expect(res.source).toBe('');
    expect(res.known).toBe(false);
  });

  it('«Контур = Маркетинг» без источника даёт marketing', () => {
    const res = resolveChannel(raw({ Контур: 'Маркетинг' }), map);
    expect(res.channel).toBe('marketing');
  });

  it('заполненный источник приоритетнее «Контур = Маркетинг»', () => {
    const res = resolveChannel(
      raw({ Контур: 'Маркетинг', Источник: 'Email Outreach' }),
      map,
    );
    expect(res.channel).toBe('outreach');
  });

  it('«Контур = Маркетинг» с источником вне справочника всё равно marketing', () => {
    const res = resolveChannel(
      raw({ Контур: 'Маркетинг', Источник: 'Нейровыдача' }),
      map,
    );
    expect(res.channel).toBe('marketing');
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

```bash
cd app && npm test -- tests/lib/firstSales/sourceChannels.test.ts
```

Ожидаемо: FAIL, `Cannot find module '@/lib/firstSales/sourceChannels'`.

- [ ] **Step 3: Реализовать**

```typescript
// app/src/lib/firstSales/sourceChannels.ts
/**
 * Свёртка значения поля «Источник» AMO в канал продаж.
 *
 * Отличие от `leadsReport/channels.ts`: там пять каналов зашиты в код и
 * покрывают 38% потока — остальное отбрасывается как `null`. Здесь свёртка
 * берётся из редактируемой таблицы `lead_source_channels`, а всё неизвестное
 * становится явным `unassigned` и видно на дашборде, а не исчезает.
 */
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';

export type FirstSalesChannel =
  | 'marketing'
  | 'smm'
  | 'outreach'
  | 'partners'
  | 'tg_outreach'
  | 'inbound'
  | 'referral'
  | 'events'
  | 'unassigned';

export const CHANNEL_LABELS: Record<FirstSalesChannel, string> = {
  marketing: 'Маркетинг',
  smm: 'SMM',
  outreach: 'Аутрич',
  partners: 'Партнёрка',
  tg_outreach: 'TG Outreach',
  inbound: 'Входящие',
  referral: 'Сарафан',
  events: 'Мероприятия',
  unassigned: 'Не распределено',
};

export type SourceChannelRow = {
  source: string;
  channel: FirstSalesChannel;
  display_name: string | null;
};

export type ResolvedChannel = {
  /** Нормализованное значение «Источник»; пустая строка, если поле не заполнено. */
  source: string;
  channel: FirstSalesChannel;
  /** Есть ли источник в справочнике. false → строка «новый источник» на дашборде. */
  known: boolean;
};

/** trim + lower + ё→е. Той же нормализацией хранится `source` в справочнике. */
export function normalizeSource(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

export function buildSourceIndex(
  rows: SourceChannelRow[],
): Map<string, SourceChannelRow> {
  return new Map(rows.map((r) => [normalizeSource(r.source), r]));
}

/**
 * Единственное правило поверх справочника: явная ручная метка команды
 * «Контур = Маркетинг» выигрывает у пустого или незнакомого источника, но
 * уступает источнику, который в справочнике есть. Метку ставят руками именно
 * для тех сделок, у которых источник не заполнен.
 */
export function resolveChannel(
  raw: unknown,
  rows: SourceChannelRow[] | Map<string, SourceChannelRow>,
): ResolvedChannel {
  const index = rows instanceof Map ? rows : buildSourceIndex(rows);

  const source = normalizeSource(extractCustomField(raw, 'Источник'));
  const hit = source ? index.get(source) : undefined;
  if (hit) return { source, channel: hit.channel, known: true };

  const kontur = normalizeSource(extractCustomField(raw, 'Контур'));
  if (kontur === 'маркетинг') return { source, channel: 'marketing', known: false };

  return { source, channel: 'unassigned', known: false };
}
```

- [ ] **Step 4: Запустить — должно пройти**

```bash
cd app && npm test -- tests/lib/firstSales/sourceChannels.test.ts
```

Ожидаемо: PASS, 11 тестов.

- [ ] **Step 5: Закоммитить**

```bash
git add app/src/lib/firstSales/sourceChannels.ts app/tests/lib/firstSales/sourceChannels.test.ts
git commit -m "feat(first-sales): свёртка источника AMO в канал продаж"
```

---

## Task 4: Границы периодов в МСК

**Files:**
- Create: `app/src/lib/firstSales/buckets.ts`
- Test: `app/tests/lib/firstSales/buckets.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```typescript
// app/tests/lib/firstSales/buckets.test.ts
import { bucketKey, buildBuckets, type GroupBy } from '@/lib/firstSales/buckets';

const d = (iso: string) => new Date(iso);

describe('bucketKey', () => {
  it('день считается по МСК, а не по UTC', () => {
    // 2026-07-14T22:30Z = 2026-07-15 01:30 МСК → корзина 15 июля
    expect(bucketKey(d('2026-07-14T22:30:00.000Z'), 'day')).toBe('2026-07-15');
  });

  it('неделя начинается с понедельника', () => {
    // 2026-07-15 — среда; понедельник этой недели 2026-07-13
    expect(bucketKey(d('2026-07-15T09:00:00.000Z'), 'week')).toBe('2026-07-13');
  });

  it('воскресенье относится к неделе, начавшейся в понедельник', () => {
    // 2026-07-19 — воскресенье
    expect(bucketKey(d('2026-07-19T09:00:00.000Z'), 'week')).toBe('2026-07-13');
  });

  it('месяц считается по МСК на границе месяца', () => {
    // 2026-06-30T21:30Z = 2026-07-01 00:30 МСК → июль, не июнь
    expect(bucketKey(d('2026-06-30T21:30:00.000Z'), 'month')).toBe('2026-07-01');
  });
});

describe('buildBuckets', () => {
  it('строит непрерывный ряд дней, включая пустые', () => {
    const keys = buildBuckets(
      d('2026-07-01T00:00:00.000Z'),
      d('2026-07-04T00:00:00.000Z'),
      'day',
    );
    expect(keys).toEqual(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  });

  it('строит ряд недель по понедельникам', () => {
    const keys = buildBuckets(
      d('2026-07-01T00:00:00.000Z'),
      d('2026-07-20T00:00:00.000Z'),
      'week',
    );
    expect(keys).toEqual(['2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20']);
  });

  it('строит ряд месяцев через границу года', () => {
    const keys = buildBuckets(
      d('2026-11-15T00:00:00.000Z'),
      d('2027-01-10T00:00:00.000Z'),
      'month',
    );
    expect(keys).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
  });

  it('одинаковые начало и конец дают одну корзину', () => {
    const keys = buildBuckets(
      d('2026-07-15T10:00:00.000Z'),
      d('2026-07-15T18:00:00.000Z'),
      'day',
    );
    expect(keys).toEqual(['2026-07-15']);
  });

  it('конец раньше начала даёт пустой ряд', () => {
    const keys: string[] = buildBuckets(
      d('2026-07-15T00:00:00.000Z'),
      d('2026-07-01T00:00:00.000Z'),
      'day' as GroupBy,
    );
    expect(keys).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

```bash
cd app && npm test -- tests/lib/firstSales/buckets.test.ts
```

Ожидаемо: FAIL, `Cannot find module '@/lib/firstSales/buckets'`.

- [ ] **Step 3: Реализовать**

```typescript
// app/src/lib/firstSales/buckets.ts
/**
 * Раскладка дат по корзинам день / неделя / месяц в московском времени.
 *
 * База живёт в UTC, бизнес — в МСК. Без явного сдвига «понедельник» уезжает
 * на три часа, и сделка, заведённая в 01:30 ночи, попадает во вчерашний день.
 * В России нет перехода на летнее время с 2014 года, поэтому фиксированный
 * сдвиг +3 корректен — тот же приём, что в `leadsReport/weekWindow.ts`.
 */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

export type GroupBy = 'day' | 'week' | 'month';

function toMsk(date: Date): Date {
  return new Date(date.getTime() + MSK_OFFSET_MS);
}

function isoDate(msk: Date): string {
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const d = String(msk.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Ключ корзины: дата её начала в МСК, формат YYYY-MM-DD. */
export function bucketKey(date: Date, groupBy: GroupBy): string {
  const msk = toMsk(date);
  if (groupBy === 'month') {
    return isoDate(new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), 1)));
  }
  if (groupBy === 'week') {
    const dow = msk.getUTCDay();            // 0 = вс
    const backToMonday = (dow + 6) % 7;     // пн → 0, вс → 6
    return isoDate(
      new Date(
        Date.UTC(
          msk.getUTCFullYear(),
          msk.getUTCMonth(),
          msk.getUTCDate() - backToMonday,
        ),
      ),
    );
  }
  return isoDate(msk);
}

/** Непрерывный ряд ключей от начала до конца включительно. Пустые корзины нужны:
 *  без них график молча схлопывает провалы, и «ноль встреч в среду» выглядит как
 *  «среды не было». */
export function buildBuckets(from: Date, to: Date, groupBy: GroupBy): string[] {
  if (to.getTime() < from.getTime()) return [];

  const keys: string[] = [];
  const lastKey = bucketKey(to, groupBy);

  const start = toMsk(from);
  let cursor: Date;
  if (groupBy === 'month') {
    cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  } else if (groupBy === 'week') {
    const backToMonday = (start.getUTCDay() + 6) % 7;
    cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - backToMonday),
    );
  } else {
    cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
    );
  }

  // Курсор уже в «МСК-пространстве» (UTC-дата, сдвинутая на +3), поэтому
  // арифметику ведём в нём и ключ берём напрямую, без повторного сдвига.
  for (let guard = 0; guard < 4000; guard += 1) {
    const key = isoDate(cursor);
    keys.push(key);
    if (key === lastKey) break;
    if (groupBy === 'month') {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    } else {
      const stepDays = groupBy === 'week' ? 7 : 1;
      cursor = new Date(
        Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth(),
          cursor.getUTCDate() + stepDays,
        ),
      );
    }
  }
  return keys;
}
```

- [ ] **Step 4: Запустить — должно пройти**

```bash
cd app && npm test -- tests/lib/firstSales/buckets.test.ts
```

Ожидаемо: PASS, 10 тестов.

- [ ] **Step 5: Закоммитить**

```bash
git add app/src/lib/firstSales/buckets.ts app/tests/lib/firstSales/buckets.test.ts
git commit -m "feat(first-sales): границы дней/недель/месяцев в МСК"
```

---

## Task 5: Расчёт метрик

**Files:**
- Create: `app/src/lib/firstSales/metrics.ts`
- Test: `app/tests/lib/firstSales/metrics.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```typescript
// app/tests/lib/firstSales/metrics.test.ts
import {
  computeFirstSalesSeries,
  type FirstSalesLeadRow,
} from '@/lib/firstSales/metrics';
import type { SourceChannelRow } from '@/lib/firstSales/sourceChannels';

const map: SourceChannelRow[] = [
  { source: 'email outreach', channel: 'outreach', display_name: 'Email Outreach' },
  { source: 'сайт', channel: 'inbound', display_name: 'Сайт' },
];

function lead(over: Partial<FirstSalesLeadRow> = {}): FirstSalesLeadRow {
  return {
    amo_id: 1,
    name: 'Обычная сделка',
    created_at: '2026-07-15T09:00:00.000Z',
    first_qualified_at: null,
    first_meeting_at: null,
    first_contract_at: null,
    won_at: null,
    history_complete: true,
    raw: {
      custom_fields_values: [
        { field_name: 'Источник', values: [{ value: 'Email Outreach' }] },
      ],
    },
    ...over,
  };
}

const from = new Date('2026-07-01T00:00:00.000Z');
const to = new Date('2026-07-31T23:59:59.999Z');

describe('computeFirstSalesSeries', () => {
  it('считает лидов по дате создания', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 }), lead({ amo_id: 2, created_at: '2026-07-16T09:00:00.000Z' })],
      map, from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(2);
    expect(res.series.find((b) => b.key === '2026-07-15')?.leads).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-16')?.leads).toBe(1);
  });

  it('мёртвые сделки и лид-магниты остаются в лидах', () => {
    // Отчёт продаж их выбрасывает; дашборд — нет, иначе прошлое едет.
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, name: 'Бот: Иван' })],
      map, from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(1);
    expect(res.totals.leadMagnets).toBe(1);
  });

  it('встречи считаются по дате достижения этапа, а не по дате создания', () => {
    const res = computeFirstSalesSeries(
      [lead({
        created_at: '2026-06-20T09:00:00.000Z',      // лид пришёл в июне
        first_meeting_at: '2026-07-10T09:00:00.000Z', // встреча в июле
      })],
      map, from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(0);
    expect(res.totals.meetings).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-10')?.meetings).toBe(1);
  });

  it('сделка с неполной историей не даёт встреч и договоров, но остаётся лидом', () => {
    const res = computeFirstSalesSeries(
      [lead({
        history_complete: false,
        first_meeting_at: '2026-07-10T09:00:00.000Z',
        first_contract_at: '2026-07-12T09:00:00.000Z',
      })],
      map, from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(1);
    expect(res.totals.meetings).toBe(0);
    expect(res.totals.contracts).toBe(0);
  });

  it('фильтр по каналам применяется ко всем метрикам', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1 }),                                            // outreach
        lead({
          amo_id: 2,
          raw: { custom_fields_values: [{ field_name: 'Источник', values: [{ value: 'Сайт' }] }] },
        }),                                                             // inbound
      ],
      map, from, to, 'day', ['outreach'],
    );
    expect(res.totals.leads).toBe(1);
  });

  it('средний цикл и медиана считаются по оплаченным в периоде', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1, created_at: '2026-07-01T00:00:00.000Z', won_at: '2026-07-11T00:00:00.000Z' }), // 10 дней
        lead({ amo_id: 2, created_at: '2026-07-01T00:00:00.000Z', won_at: '2026-07-21T00:00:00.000Z' }), // 20 дней
        lead({ amo_id: 3, created_at: '2026-01-01T00:00:00.000Z', won_at: '2026-07-31T00:00:00.000Z' }), // 211 дней
      ],
      map, from, to, 'day', null,
    );
    expect(res.totals.wonCount).toBe(3);
    expect(res.totals.cycleMedianDays).toBe(20);
    expect(Math.round(res.totals.cycleAvgDays ?? 0)).toBe(80);
  });

  it('пустая выборка не даёт NaN', () => {
    const res = computeFirstSalesSeries([], map, from, to, 'day', null);
    expect(res.totals.leads).toBe(0);
    expect(res.totals.cycleAvgDays).toBeNull();
    expect(res.totals.cycleMedianDays).toBeNull();
  });

  it('пустые корзины присутствуют в ряду', () => {
    const res = computeFirstSalesSeries([lead()], map, from, to, 'day', null);
    expect(res.series).toHaveLength(31);
    expect(res.series[0]).toEqual(
      expect.objectContaining({ key: '2026-07-01', leads: 0, meetings: 0 }),
    );
  });

  it('считает разбивку по источникам с пометкой неизвестных', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1 }),
        lead({
          amo_id: 2,
          raw: { custom_fields_values: [{ field_name: 'Источник', values: [{ value: 'Нейровыдача' }] }] },
        }),
      ],
      map, from, to, 'day', null,
    );
    const unknown = res.bySource.find((s) => s.source === 'нейровыдача');
    expect(unknown?.leads).toBe(1);
    expect(unknown?.known).toBe(false);
    expect(res.totals.unassignedLeads).toBe(1);
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

```bash
cd app && npm test -- tests/lib/firstSales/metrics.test.ts
```

Ожидаемо: FAIL, `Cannot find module '@/lib/firstSales/metrics'`.

- [ ] **Step 3: Реализовать**

```typescript
// app/src/lib/firstSales/metrics.ts
/**
 * Метрики дашборда первички.
 *
 * Отличия от `salesReport/metrics.ts` — сознательные, зафиксированы в спеке:
 *   1. Лиды считаются ВСЕ, включая закрытые в минус и лид-магниты. Отчёт продаж
 *      их выбрасывает; для дашборда это означало бы, что число лидов за май
 *      уменьшается задним числом каждый раз, когда майскую сделку закрывают.
 *      Прошлое должно быть неподвижным.
 *   2. Встречи и договоры считаются по ДАТЕ достижения этапа из истории
 *      переходов, а не когортно «из пришедших в окне дошли до».
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { bucketKey, buildBuckets, type GroupBy } from '@/lib/firstSales/buckets';
import {
  buildSourceIndex,
  resolveChannel,
  type FirstSalesChannel,
  type SourceChannelRow,
} from '@/lib/firstSales/sourceChannels';

export type FirstSalesLeadRow = {
  amo_id: number;
  name: string | null;
  created_at: string | null;
  first_qualified_at: string | null;
  first_meeting_at: string | null;
  first_contract_at: string | null;
  won_at: string | null;
  history_complete: boolean;
  raw: unknown;
};

export type SeriesBucket = {
  key: string;
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
};

export type SourceBreakdown = {
  source: string;
  channel: FirstSalesChannel;
  known: boolean;
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
};

export type FirstSalesTotals = {
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
  leadMagnets: number;
  unassignedLeads: number;
  wonCount: number;
  cycleAvgDays: number | null;
  cycleMedianDays: number | null;
};

export type FirstSalesSeries = {
  series: SeriesBucket[];
  bySource: SourceBreakdown[];
  totals: FirstSalesTotals;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Лид-магнит — сделка, автосозданная TG-ботом «Polza Site Feedback»:
 *  имя всегда с префиксом «Бот:». Из лидов не исключается, но считается
 *  отдельно, чтобы всплеск магнитов не читался как рост спроса. */
function isLeadMagnet(name: string | null): boolean {
  return typeof name === 'string' && name.trimStart().startsWith('Бот:');
}

function inWindow(value: string | null, from: Date, to: Date): boolean {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeFirstSalesSeries(
  leads: FirstSalesLeadRow[],
  sourceMap: SourceChannelRow[],
  from: Date,
  to: Date,
  groupBy: GroupBy,
  channelFilter: FirstSalesChannel[] | null,
): FirstSalesSeries {
  const index = buildSourceIndex(sourceMap);
  const allowed = channelFilter && channelFilter.length > 0 ? new Set(channelFilter) : null;

  const keys = buildBuckets(from, to, groupBy);
  const series = new Map<string, SeriesBucket>(
    keys.map((key) => [key, { key, leads: 0, qualified: 0, meetings: 0, contracts: 0 }]),
  );
  const bySource = new Map<string, SourceBreakdown>();

  const totals: FirstSalesTotals = {
    leads: 0, qualified: 0, meetings: 0, contracts: 0,
    leadMagnets: 0, unassignedLeads: 0, wonCount: 0,
    cycleAvgDays: null, cycleMedianDays: null,
  };
  const cycles: number[] = [];

  // Тип поля сужен до счётчиков: `keyof SeriesBucket` включал бы `key: string`,
  // и `bucket[field] += 1` не прошёл бы проверку типов.
  type CounterField = 'leads' | 'qualified' | 'meetings' | 'contracts';
  const bump = (key: string | null, field: CounterField) => {
    if (!key) return;
    const bucket = series.get(key);
    if (bucket) bucket[field] += 1;
  };

  for (const lead of leads) {
    const resolved = resolveChannel(lead.raw, index);
    if (allowed && !allowed.has(resolved.channel)) continue;

    const sourceKey = resolved.source || '(не указан)';
    let breakdown = bySource.get(sourceKey);
    if (!breakdown) {
      breakdown = {
        source: sourceKey,
        channel: resolved.channel,
        known: resolved.known,
        leads: 0, qualified: 0, meetings: 0, contracts: 0,
      };
      bySource.set(sourceKey, breakdown);
    }

    // Лиды — по дате создания. Без исключений по статусу.
    if (inWindow(lead.created_at, from, to)) {
      totals.leads += 1;
      breakdown.leads += 1;
      bump(bucketKey(new Date(lead.created_at as string), groupBy), 'leads');
      if (isLeadMagnet(lead.name)) totals.leadMagnets += 1;
      if (resolved.channel === 'unassigned') totals.unassignedLeads += 1;

      if (lead.first_qualified_at && lead.history_complete) {
        totals.qualified += 1;
        breakdown.qualified += 1;
        bump(bucketKey(new Date(lead.created_at as string), groupBy), 'qualified');
      }
    }

    // Встречи и договоры — по дате достижения этапа. Сделка с неполной историей
    // исключается: у неё переход мог случиться до горизонта событий, и мы его
    // не видели. Считать её нулём — врать.
    if (lead.history_complete) {
      if (inWindow(lead.first_meeting_at, from, to)) {
        totals.meetings += 1;
        breakdown.meetings += 1;
        bump(bucketKey(new Date(lead.first_meeting_at as string), groupBy), 'meetings');
      }
      if (inWindow(lead.first_contract_at, from, to)) {
        totals.contracts += 1;
        breakdown.contracts += 1;
        bump(bucketKey(new Date(lead.first_contract_at as string), groupBy), 'contracts');
      }
    }

    // Цикл — от создания до оплаты, по оплаченным в окне. От глубины истории
    // событий не зависит: won_at приходит из closed_at.
    if (inWindow(lead.won_at, from, to) && lead.created_at) {
      const days =
        (new Date(lead.won_at as string).getTime() - new Date(lead.created_at).getTime()) / DAY_MS;
      if (Number.isFinite(days) && days >= 0) {
        totals.wonCount += 1;
        cycles.push(days);
      }
    }
  }

  if (cycles.length > 0) {
    totals.cycleAvgDays = cycles.reduce((a, b) => a + b, 0) / cycles.length;
    totals.cycleMedianDays = median(cycles);
  }

  return {
    series: keys.map((k) => series.get(k) as SeriesBucket),
    // Пустые строки отбрасываем: выборка тянет сделки с любой активностью в
    // окне, поэтому источник может попасть в разбивку из-за оплаты старой
    // сделки и дать строку из одних нулей. Строка «источник, по которому
    // ничего не произошло» — шум, а не факт.
    bySource: [...bySource.values()]
      .filter((s) => s.leads + s.qualified + s.meetings + s.contracts > 0)
      .sort((a, b) => b.leads - a.leads),
    totals,
  };
}

/** Тянет сделки воронки первички вместе с датами этапов из view. */
export async function fetchFirstSalesLeads(
  db: SupabaseClient,
  pipelineId: number,
  from: Date,
  to: Date,
): Promise<FirstSalesLeadRow[]> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // Берём сделки с ЛЮБОЙ активностью в окне: созданы, дошли до встречи,
  // до договора или оплачены. Иначе встреча июльской сделки, пришедшей в июне,
  // в июльское окно не попадёт.
  const { data, error } = await db
    .from('amo_lead_stage_dates_v')
    .select(
      'amo_deal_id, created_at, first_qualified_at, first_meeting_at, first_contract_at, won_at, history_complete',
    )
    .eq('pipeline_id', pipelineId)
    .or(
      `and(created_at.gte.${fromIso},created_at.lte.${toIso}),` +
        `and(first_meeting_at.gte.${fromIso},first_meeting_at.lte.${toIso}),` +
        `and(first_contract_at.gte.${fromIso},first_contract_at.lte.${toIso}),` +
        `and(won_at.gte.${fromIso},won_at.lte.${toIso})`,
    );
  if (error) throw error;

  const stageRows = (data ?? []) as Array<
    Omit<FirstSalesLeadRow, 'amo_id' | 'name' | 'raw'> & { amo_deal_id: number }
  >;
  if (stageRows.length === 0) return [];

  const ids = stageRows.map((r) => r.amo_deal_id);
  const { data: leadsData, error: leadsError } = await db
    .from('amo_leads')
    .select('amo_id, name, raw')
    .in('amo_id', ids);
  if (leadsError) throw leadsError;

  const byId = new Map(
    ((leadsData ?? []) as Array<{ amo_id: number; name: string | null; raw: unknown }>).map(
      (l) => [l.amo_id, l],
    ),
  );

  return stageRows.map((r) => ({
    amo_id: r.amo_deal_id,
    name: byId.get(r.amo_deal_id)?.name ?? null,
    raw: byId.get(r.amo_deal_id)?.raw ?? null,
    created_at: r.created_at,
    first_qualified_at: r.first_qualified_at,
    first_meeting_at: r.first_meeting_at,
    first_contract_at: r.first_contract_at,
    won_at: r.won_at,
    history_complete: r.history_complete,
  }));
}

export async function fetchSourceMap(db: SupabaseClient): Promise<SourceChannelRow[]> {
  const { data, error } = await db
    .from('lead_source_channels')
    .select('source, channel, display_name')
    .order('sort_order');
  if (error) throw error;
  return (data ?? []) as SourceChannelRow[];
}
```

- [ ] **Step 4: Запустить — должно пройти**

```bash
cd app && npm test -- tests/lib/firstSales/metrics.test.ts
```

Ожидаемо: PASS, 9 тестов.

- [ ] **Step 5: Закоммитить**

```bash
git add app/src/lib/firstSales/metrics.ts app/tests/lib/firstSales/metrics.test.ts
git commit -m "feat(first-sales): расчёт метрик воронки первички"
```

---

## Task 6: Синк истории переходов из AMO

**Files:**
- Create: `services/portal-external-sync/sources/amo_events.py`
- Modify: `services/portal-external-sync/main.py`

- [ ] **Step 1: Написать источник**

```python
# services/portal-external-sync/sources/amo_events.py
"""AMO CRM → amo_events: история переходов сделок по этапам.

Зачем: в amo_leads есть только ТЕКУЩИЙ этап сделки. Без истории нельзя
ответить «сколько встреч провели во вторник» — можно только «из лидов
вторника дошли до встречи», а это когортная метрика, которая едет задним
числом. Дашборд первички считает встречи и договоры по дате перехода.

Инкрементально: от времени последнего успешного прогона минус нахлёст в
двое суток (AMO может отдать событие с задержкой). Уникальный ключ
(amo_deal_id, event_type, changed_at) делает повторный прогон безвредным.

Разовый бэкфилл за всю глубину — app/scripts/backfill-amo-events.mjs.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx

from .base import SyncSource

TOKEN = (os.environ.get("AMO_ACCESS_TOKEN") or os.environ.get("AMOCRM_TOKEN") or "").strip()
BASE_URL = os.environ.get("AMO_BASE_URL", "").strip().rstrip("/")

PAGE_LIMIT = int(os.environ.get("AMO_EVENTS_PAGE_LIMIT", "100"))
MAX_PAGES = int(os.environ.get("AMO_EVENTS_MAX_PAGES", "500"))
INTER_PAGE_DELAY_SEC = float(os.environ.get("AMO_INTER_PAGE_DELAY_SEC", "0.2"))
OVERLAP_DAYS = 2

EVENT_TYPE = "lead_status_changed"


class AmoEventsSync(SyncSource):
    #: Имя уже разрешено CHECK-констрейнтом external_sync_runs.source.
    name = "amo_events"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not TOKEN or not BASE_URL:
            raise NotImplementedError("AMO_ACCESS_TOKEN / AMO_BASE_URL не заданы")

        since = await self._watermark(conn)
        headers = {"Authorization": f"Bearer {TOKEN}"}
        total = 0

        async with httpx.AsyncClient(timeout=60, headers=headers) as client:
            for page in range(1, MAX_PAGES + 1):
                url = (
                    f"{BASE_URL}/api/v4/events"
                    f"?limit={PAGE_LIMIT}&page={page}"
                    f"&filter[type][]={EVENT_TYPE}"
                    f"&filter[created_at][from]={int(since.timestamp())}"
                )
                resp = await client.get(url)
                if resp.status_code == 204:
                    break  # AMO отдаёт 204 на пустой странице
                resp.raise_for_status()

                events = (resp.json().get("_embedded") or {}).get("events") or []
                if not events:
                    break

                rows = [r for r in (self._to_row(e) for e in events) if r is not None]
                if rows:
                    await self._upsert(conn, rows)
                    total += len(rows)

                await asyncio.sleep(INTER_PAGE_DELAY_SEC)

        return total

    async def _watermark(self, conn: asyncpg.Connection) -> datetime:
        """Начало окна: последний успешный прогон минус нахлёст.

        Если успешных прогонов ещё не было — берём максимум из уже загруженных
        событий (после бэкфилла), иначе месяц назад. Полную глубину тянет
        бэкфилл-скрипт, а не ночной синк: тяжёлый прогон в штатном окне
        задержал бы все следующие источники.
        """
        row = await conn.fetchrow(
            """SELECT max(started_at) AS ts FROM external_sync_runs
               WHERE source = $1 AND status = 'success'""",
            self.name,
        )
        if row and row["ts"]:
            return row["ts"] - timedelta(days=OVERLAP_DAYS)

        row = await conn.fetchrow("SELECT max(changed_at) AS ts FROM amo_events")
        if row and row["ts"]:
            return row["ts"] - timedelta(days=OVERLAP_DAYS)

        return datetime.now(timezone.utc) - timedelta(days=30)

    @staticmethod
    def _to_row(event: dict) -> tuple | None:
        deal_id = event.get("entity_id")
        if not deal_id or event.get("entity_type") != "lead":
            return None

        created = event.get("created_at")
        if not created:
            return None
        changed_at = datetime.fromtimestamp(int(created), tz=timezone.utc)

        def status_of(side: str) -> str | None:
            arr = event.get(side) or []
            if not arr:
                return None
            node = (arr[0] or {}).get("lead_status") or {}
            sid = node.get("id")
            return str(sid) if sid is not None else None

        return (
            int(deal_id),
            EVENT_TYPE,
            changed_at,
            event.get("created_by"),
            status_of("value_before"),
            status_of("value_after"),
            json.dumps(event, ensure_ascii=False),
        )

    @staticmethod
    async def _upsert(conn: asyncpg.Connection, rows: list[tuple]) -> None:
        await conn.executemany(
            """INSERT INTO amo_events (
                 amo_deal_id, event_type, changed_at, changed_by,
                 from_value, to_value, payload
               ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
               ON CONFLICT (amo_deal_id, event_type, changed_at) DO UPDATE SET
                 from_value = EXCLUDED.from_value,
                 to_value   = EXCLUDED.to_value,
                 payload    = EXCLUDED.payload,
                 synced_at  = now()""",
            rows,
        )
```

- [ ] **Step 2: Зарегистрировать источник в оркестраторе**

В `services/portal-external-sync/main.py` добавить импорт рядом с существующими (после строки `from sources.amo_enrich import AmoCompanyEnrichSync`):

```python
from sources.amo_events import AmoEventsSync
```

и вставить в список `SOURCES` **строго после** `AmoSync()` — источнику нужны свежие `amo_statuses` для порогов `sort`:

```python
SOURCES = [
    MetrikaSync(),
    AmoSync(),
    AmoEventsSync(),         # после AmoSync: нужны свежие amo_statuses
    AmoCompanyEnrichSync(),  # ходит на company_website и заполняет company_name; идёт СТРОГО после AmoSync
    BankTochkaSync(),
    BankTBankSync(),
]
```

- [ ] **Step 3: Проверить, что модуль импортируется и синтаксис верен**

```bash
cd services/portal-external-sync && python -c "from sources.amo_events import AmoEventsSync; print(AmoEventsSync().name)"
```

Ожидаемо: `amo_events`.

- [ ] **Step 4: Прогнать источник вживую и убедиться, что события появились**

```bash
cd services/portal-external-sync && python -c "
import asyncio, asyncpg, os
from sources.amo_events import AmoEventsSync
async def main():
    conn = await asyncpg.connect(os.environ['DATABASE_URL'])
    n = await AmoEventsSync().run(conn)
    print('upserted', n)
    print(await conn.fetchval('select count(*) from amo_events'))
    await conn.close()
asyncio.run(main())
"
```

Ожидаемо: `upserted N` с N > 0 и непустой счётчик в `amo_events`. Повторный запуск той же команды должен дать тот же счётчик в таблице — это и есть проверка идемпотентности.

- [ ] **Step 5: Закоммитить**

```bash
git add services/portal-external-sync/sources/amo_events.py services/portal-external-sync/main.py
git commit -m "feat(first-sales): синк истории переходов сделок из AMO"
```

---

## Task 7: Бэкфилл истории за всю глубину

**Files:**
- Create: `app/scripts/backfill-amo-events.mjs`

- [ ] **Step 1: Написать скрипт**

```javascript
// app/scripts/backfill-amo-events.mjs
// Разовый бэкфилл истории переходов из AMO за всю доступную глубину.
// Тяжёлый прогон — запускается руками, НЕ в штатном окне синка.
// Запуск: node scripts/backfill-amo-events.mjs 2025-01-01
import 'dotenv/config';
import pg from 'pg';

const TOKEN = (process.env.AMO_ACCESS_TOKEN || process.env.AMOCRM_TOKEN || '').trim();
const BASE = (process.env.AMO_BASE_URL || '').trim().replace(/\/$/, '');
const DB = process.env.DATABASE_URL;
const SINCE = process.argv[2];

if (!TOKEN || !BASE || !DB || !SINCE) {
  console.error('Использование: node scripts/backfill-amo-events.mjs YYYY-MM-DD');
  console.error('Нужны AMO_ACCESS_TOKEN, AMO_BASE_URL, DATABASE_URL в .env');
  process.exit(1);
}

const fromUnix = Math.floor(new Date(`${SINCE}T00:00:00Z`).getTime() / 1000);
const client = new pg.Client({ connectionString: DB });
await client.connect();

const SQL = `
  INSERT INTO amo_events (amo_deal_id, event_type, changed_at, changed_by, from_value, to_value, payload)
  VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
  ON CONFLICT (amo_deal_id, event_type, changed_at) DO UPDATE SET
    from_value = EXCLUDED.from_value,
    to_value   = EXCLUDED.to_value,
    payload    = EXCLUDED.payload,
    synced_at  = now()`;

const statusOf = (event, side) => {
  const node = (event[side] || [])[0]?.lead_status;
  return node?.id != null ? String(node.id) : null;
};

let total = 0;
for (let page = 1; page <= 5000; page += 1) {
  const url =
    `${BASE}/api/v4/events?limit=100&page=${page}` +
    `&filter[type][]=lead_status_changed` +
    `&filter[created_at][from]=${fromUnix}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 204) break;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} на странице ${page}`);

  const events = (await res.json())?._embedded?.events ?? [];
  if (events.length === 0) break;

  for (const e of events) {
    if (e.entity_type !== 'lead' || !e.entity_id || !e.created_at) continue;
    await client.query(SQL, [
      e.entity_id,
      'lead_status_changed',
      new Date(e.created_at * 1000).toISOString(),
      e.created_by ?? null,
      statusOf(e, 'value_before'),
      statusOf(e, 'value_after'),
      JSON.stringify(e),
    ]);
    total += 1;
  }

  if (page % 20 === 0) console.log(`страница ${page}, загружено ${total}`);
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`готово: ${total} событий`);
const { rows } = await client.query(
  'select count(*) cnt, min(changed_at) mn, max(changed_at) mx from amo_events',
);
console.log(rows[0]);
await client.end();
```

- [ ] **Step 2: Запустить бэкфилл с даты, найденной в Task 1**

```bash
cd app && node scripts/backfill-amo-events.mjs 2025-01-01
```

Ожидаемо: строки прогресса и итог вида `{ cnt: '48213', mn: 2025-01-01..., mx: 2026-07-30... }`.

- [ ] **Step 3: Написать проверку view на реальных данных**

Самая тонкая логика этапа — «проскок этапа засчитывается» и «сделка, созданная сразу на высоком этапе, события не порождает» — живёт в SQL и юнит-тестами не покрывается. Проверяем её на боевых данных.

```javascript
// app/scripts/verify-stage-dates.mjs
// Проверка view amo_lead_stage_dates_v на реальных данных после бэкфилла.
// Запуск: node scripts/verify-stage-dates.mjs
import 'dotenv/config';
import pg from 'pg';

const PIPELINE = 7670334;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const q = async (sql, params = []) => (await c.query(sql, params)).rows;

const [shape] = await q(
  `select count(*) total,
          count(*) filter (where history_complete) complete,
          count(*) filter (where first_meeting_at is not null) with_meeting,
          count(*) filter (where first_contract_at is not null) with_contract
     from amo_lead_stage_dates_v where pipeline_id = $1`,
  [PIPELINE],
);
console.log('форма данных:', shape);

// Проскок: сделка дошла до договора (sort 110), но события с «Встреча
// проведена» (ровно sort 70) у неё нет. Встреча обязана быть засчитана.
const skipped = await q(
  `select v.amo_deal_id, v.first_meeting_at, v.first_contract_at
     from amo_lead_stage_dates_v v
    where v.pipeline_id = $1
      and v.history_complete
      and v.first_contract_at is not null
      and not exists (
        select 1 from amo_events e
        join amo_statuses s on s.pipeline_id = $1
                           and s.status_id = nullif(e.to_value,'')::bigint
       where e.amo_deal_id = v.amo_deal_id
         and e.event_type = 'lead_status_changed'
         and s.sort = 70
      )
    limit 20`,
  [PIPELINE],
);
const skippedBroken = skipped.filter((r) => r.first_meeting_at === null);
console.log(`проскок этапа: найдено ${skipped.length}, из них без встречи ${skippedBroken.length}`);
if (skippedBroken.length > 0) {
  console.log('ПРОВАЛ: проскок не засчитан, пример:', skippedBroken[0]);
  process.exitCode = 1;
}

// Сделка вообще без событий: даты этапов должны выводиться из текущего статуса.
const [noEvents] = await q(
  `select count(*) cnt,
          count(*) filter (where v.first_qualified_at is not null) with_qual
     from amo_lead_stage_dates_v v
     join amo_leads l on l.amo_id = v.amo_deal_id
     join amo_statuses s on s.pipeline_id = l.pipeline_id and s.status_id = l.status_id
    where v.pipeline_id = $1
      and v.history_complete
      and s.sort >= 40
      and not exists (select 1 from amo_events e where e.amo_deal_id = v.amo_deal_id)`,
  [PIPELINE],
);
console.log('без событий, но статус ≥ квал:', noEvents);
if (Number(noEvents.cnt) > 0 && Number(noEvents.with_qual) !== Number(noEvents.cnt)) {
  console.log('ПРОВАЛ: у сделок без событий не проставлен first_qualified_at');
  process.exitCode = 1;
}

if (!process.exitCode) console.log('OK: view ведёт себя как задумано.');
await c.end();
```

- [ ] **Step 4: Запустить проверку**

```bash
cd app && node scripts/verify-stage-dates.mjs
```

Ожидаемо: `total` около 5100; `with_meeting` и `with_contract` заметно больше нуля; последняя строка `OK: view ведёт себя как задумано.`

Если `with_meeting` равен нулю — события с нужными статусами не пришли; разбираться до перехода к следующей задаче, дальше строить нечего. Если `ПРОВАЛ` — чинить определение view в миграции Task 2.

- [ ] **Step 5: Закоммитить**

```bash
git add app/scripts/backfill-amo-events.mjs app/scripts/verify-stage-dates.mjs
git commit -m "feat(first-sales): бэкфилл истории переходов AMO и проверка view"
```

---

## Task 8: Nav-вкладка и гард доступа

**Files:**
- Modify: `app/src/lib/toolsRegistry.ts:8-23`
- Modify: `app/src/lib/navigation.ts:23-52`
- Modify: `app/src/components/Sidebar.tsx:99`
- Modify: `app/src/components/TopNav.tsx:36`
- Create: `app/src/lib/firstSales/access.ts`
- Test: `app/tests/lib/firstSales/access.test.ts`

- [ ] **Step 1: Написать падающий тест гарда**

```typescript
// app/tests/lib/firstSales/access.test.ts
const getUser = jest.fn();
const maybeSingle = jest.fn();
const single = jest.fn();

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (h: string | null) => (h ? h.replace('Bearer ', '') : null),
  createAuthedSupabaseClient: () => ({ auth: { getUser } }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle }),
          single,
          maybeSingle,
        }),
      }),
      _table: table,
    }),
  },
}));

import { requireFirstSalesAccess } from '@/lib/firstSales/access';

const req = (auth: string | null) =>
  ({ headers: { get: () => auth } }) as unknown as Parameters<typeof requireFirstSalesAccess>[0];

describe('requireFirstSalesAccess', () => {
  beforeEach(() => {
    getUser.mockReset();
    maybeSingle.mockReset();
    single.mockReset();
  });

  // Гард возвращает размеченное объединение, поэтому сужаем через `'error' in res`
  // — тот же приём, что в src/app/api/database-review/requests/route.ts:15.
  const statusOf = (res: Awaited<ReturnType<typeof requireFirstSalesAccess>>) =>
    'error' in res ? res.error.status : null;

  it('без токена — 401', async () => {
    expect(statusOf(await requireFirstSalesAccess(req(null)))).toBe(401);
  });

  it('админ проходит без строки видимости', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    single.mockResolvedValue({ data: { role: 'admin' }, error: null });
    maybeSingle.mockResolvedValue({ data: null });
    expect(statusOf(await requireFirstSalesAccess(req('Bearer t')))).toBeNull();
  });

  it('обычный пользователь с enabled=true проходит', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u2' } } });
    single.mockResolvedValue({ data: { role: 'specialist' }, error: null });
    maybeSingle.mockResolvedValue({ data: { enabled: true } });
    expect(statusOf(await requireFirstSalesAccess(req('Bearer t')))).toBeNull();
  });

  it('обычный пользователь без строки — 403', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u3' } } });
    single.mockResolvedValue({ data: { role: 'specialist' }, error: null });
    maybeSingle.mockResolvedValue({ data: null });
    expect(statusOf(await requireFirstSalesAccess(req('Bearer t')))).toBe(403);
  });

  it('обычный пользователь с enabled=false — 403', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u4' } } });
    single.mockResolvedValue({ data: { role: 'specialist' }, error: null });
    maybeSingle.mockResolvedValue({ data: { enabled: false } });
    expect(statusOf(await requireFirstSalesAccess(req('Bearer t')))).toBe(403);
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

```bash
cd app && npm test -- tests/lib/firstSales/access.test.ts
```

Ожидаемо: FAIL, `Cannot find module '@/lib/firstSales/access'`.

- [ ] **Step 3: Реализовать гард**

```typescript
// app/src/lib/firstSales/access.ts
import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

export const FIRST_SALES_NAV_TAB_ID = 'nav-first-sales';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Доступ к дашборду первички. Схема та же, что у дашборда расходов:
 * скрытый пункт меню — не защита, поэтому каждый роут проверяется на сервере.
 * Админ проходит всегда; остальным вкладка выдаётся точечно в админке.
 */
export async function requireFirstSalesAccess(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  // PGRST116 = «строки нет»; это отсутствие профиля, а не сбой БД. Любую другую
  // ошибку отдаём как 503: иначе блип базы читается как «доступ запрещён».
  if (error && error.code !== 'PGRST116') {
    return { error: jsonError('role_check_failed', 503) };
  }
  if (isAdmin((profile?.role ?? null) as UserRole | null)) {
    return { user, supabaseAdmin };
  }

  const { data: row } = await supabaseAdmin
    .from('user_tool_visibility')
    .select('enabled')
    .eq('user_id', user.id)
    .eq('tool_id', FIRST_SALES_NAV_TAB_ID)
    .maybeSingle();

  if (row?.enabled !== true) {
    return { error: jsonError('Forbidden: first-sales access required', 403) };
  }
  return { user, supabaseAdmin };
}
```

- [ ] **Step 4: Зарегистрировать вкладку**

В `app/src/lib/toolsRegistry.ts` заменить строки 8–23 на:

```typescript
/** Идентификаторы вкладок боковой панели, управляемых через admin */
export const ALL_NAV_TAB_IDS = ['nav-tasks-board', 'nav-first-sales'] as const;
export type NavTabId = (typeof ALL_NAV_TAB_IDS)[number];

export interface NavTabConfig {
  id: NavTabId;
  title: string;
  description: string;
  /**
   * Вкладка видна админу всегда, без строки в user_tool_visibility.
   * Нужен потому, что видимость по умолчанию выключена (UserProvider), а
   * фильтр в Sidebar/TopNav про роли не знает — без флага вкладку не увидел бы
   * и админ. Ставится только там, где это осознанно.
   */
  adminAlwaysOn?: boolean;
}

export const NAV_TABS_CONFIG: Record<NavTabId, NavTabConfig> = {
  'nav-tasks-board': {
    id: 'nav-tasks-board',
    title: 'Доска',
    description: 'Отдельный пункт в боковой панели для открытия доски задач',
  },
  'nav-first-sales': {
    id: 'nav-first-sales',
    title: 'Первичка',
    description: 'Дашборд первичных продаж: лиды по источникам, встречи, договоры, цикл сделки',
    adminAlwaysOn: true,
  },
};
```

В `app/src/lib/navigation.ts` добавить пункт сразу после строки с `mailbox-load`:

```typescript
  { id: 'first-sales', name: 'Первичка', nameEn: 'First sales', href: '/analytics/first-sales', navTabId: 'nav-first-sales' },
```

- [ ] **Step 5: Научить навигацию флагу adminAlwaysOn**

В `app/src/components/Sidebar.tsx` заменить строку 99:

```typescript
          if (item.navTabId && navTabVisibility[item.navTabId] === false) return null;
```

на:

```typescript
          if (
            item.navTabId
            && navTabVisibility[item.navTabId] === false
            && !(NAV_TABS_CONFIG[item.navTabId as NavTabId]?.adminAlwaysOn && isAdmin(userRole))
          ) return null;
```

и добавить импорт к существующим:

```typescript
import { NAV_TABS_CONFIG, type NavTabId } from '@/lib/toolsRegistry';
```

В `app/src/components/TopNav.tsx` заменить строку 36:

```typescript
    if (item.navTabId && navTabVisibility[item.navTabId] === false) return false;
```

на:

```typescript
    if (
      item.navTabId
      && navTabVisibility[item.navTabId] === false
      && !(NAV_TABS_CONFIG[item.navTabId as NavTabId]?.adminAlwaysOn && isAdmin(userRole))
    ) return false;
```

и добавить тот же импорт.

**Проверка перед правкой:** если парная задача по расходам уже добавила `adminAlwaysOn` в `NavTabConfig` и в оба компонента — не дублировать, только добавить свою запись в `NAV_TABS_CONFIG`.

- [ ] **Step 6: Запустить тесты и сборку типов**

```bash
cd app && npm test -- tests/lib/firstSales/access.test.ts && npx tsc --noEmit
```

Ожидаемо: тесты PASS (5 штук), `tsc` без ошибок.

- [ ] **Step 7: Закоммитить**

```bash
git add app/src/lib/firstSales/access.ts app/tests/lib/firstSales/access.test.ts app/src/lib/toolsRegistry.ts app/src/lib/navigation.ts app/src/components/Sidebar.tsx app/src/components/TopNav.tsx
git commit -m "feat(first-sales): вкладка «Первичка» и серверный гард доступа"
```

---

## Task 9: API-роуты

**Files:**
- Create: `app/src/app/api/analytics/first-sales/summary/route.ts`
- Create: `app/src/app/api/analytics/first-sales/source-map/route.ts`
- Create: `app/src/lib/firstSales/params.ts`
- Test: `app/tests/api/firstSalesSummaryRoute.test.ts`

- [ ] **Step 1: Написать разбор параметров с тестом**

```typescript
// app/tests/lib/firstSales/params.test.ts
import { parseFirstSalesParams } from '@/lib/firstSales/params';

const url = (qs: string) => new URL(`https://x.test/api?${qs}`);

describe('parseFirstSalesParams', () => {
  it('разбирает корректные параметры', () => {
    const p = parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31&groupBy=week&channel=outreach&channel=smm'));
    expect(p.error).toBeNull();
    expect(p.value?.groupBy).toBe('week');
    expect(p.value?.channels).toEqual(['outreach', 'smm']);
    expect(p.value?.from.toISOString()).toBe('2026-06-30T21:00:00.000Z'); // 1 июля 00:00 МСК
  });

  it('конец периода включает весь последний день по МСК', () => {
    const p = parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31'));
    expect(p.value?.to.toISOString()).toBe('2026-07-31T20:59:59.999Z'); // 31 июля 23:59:59.999 МСК
  });

  it('groupBy по умолчанию — day', () => {
    expect(parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31')).value?.groupBy).toBe('day');
  });

  it('неизвестный groupBy отвергается', () => {
    expect(parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31&groupBy=hour')).error)
      .toMatch(/groupBy/);
  });

  it('неизвестный канал отвергается', () => {
    expect(parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31&channel=нечто')).error)
      .toMatch(/channel/);
  });

  it('отсутствие дат отвергается', () => {
    expect(parseFirstSalesParams(url('groupBy=day')).error).toMatch(/from/);
  });

  it('конец раньше начала отвергается', () => {
    expect(parseFirstSalesParams(url('from=2026-07-31&to=2026-07-01')).error).toMatch(/раньше/);
  });

  it('слишком длинный период отвергается', () => {
    expect(parseFirstSalesParams(url('from=2020-01-01&to=2026-07-01')).error).toMatch(/период/i);
  });
});
```

Запустить, убедиться что падает:

```bash
cd app && npm test -- tests/lib/firstSales/params.test.ts
```

Ожидаемо: FAIL, `Cannot find module '@/lib/firstSales/params'`.

- [ ] **Step 2: Реализовать разбор параметров**

```typescript
// app/src/lib/firstSales/params.ts
import type { GroupBy } from '@/lib/firstSales/buckets';
import type { FirstSalesChannel } from '@/lib/firstSales/sourceChannels';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 800;

const GROUP_BYS: GroupBy[] = ['day', 'week', 'month'];
const CHANNELS: FirstSalesChannel[] = [
  'marketing', 'smm', 'outreach', 'partners',
  'tg_outreach', 'inbound', 'referral', 'events', 'unassigned',
];

export type FirstSalesParams = {
  from: Date;
  to: Date;
  groupBy: GroupBy;
  channels: FirstSalesChannel[] | null;
};

/** Границы приходят как YYYY-MM-DD и трактуются как МСК-сутки целиком:
 *  from — 00:00:00.000 МСК, to — 23:59:59.999 МСК того же дня. Иначе
 *  «по 31 июля» отрежет последний день. */
export function parseFirstSalesParams(
  url: URL,
): { value: FirstSalesParams; error: null } | { value: null; error: string } {
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  if (!fromRaw || !toRaw) return { value: null, error: 'Нужны параметры from и to (YYYY-MM-DD)' };

  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(fromRaw) || !isDate(toRaw)) {
    return { value: null, error: 'from и to должны быть в формате YYYY-MM-DD' };
  }

  const from = new Date(new Date(`${fromRaw}T00:00:00.000Z`).getTime() - MSK_OFFSET_MS);
  const to = new Date(new Date(`${toRaw}T23:59:59.999Z`).getTime() - MSK_OFFSET_MS);
  if (to.getTime() < from.getTime()) {
    return { value: null, error: 'Конец периода раньше начала' };
  }
  const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (days > MAX_RANGE_DAYS) {
    return { value: null, error: `Слишком длинный период: максимум ${MAX_RANGE_DAYS} дней` };
  }

  const groupByRaw = url.searchParams.get('groupBy') ?? 'day';
  if (!GROUP_BYS.includes(groupByRaw as GroupBy)) {
    return { value: null, error: `Недопустимый groupBy: ${groupByRaw}` };
  }

  const channelRaw = url.searchParams.getAll('channel');
  for (const c of channelRaw) {
    if (!CHANNELS.includes(c as FirstSalesChannel)) {
      return { value: null, error: `Недопустимый channel: ${c}` };
    }
  }

  return {
    value: {
      from,
      to,
      groupBy: groupByRaw as GroupBy,
      channels: channelRaw.length > 0 ? (channelRaw as FirstSalesChannel[]) : null,
    },
    error: null,
  };
}
```

Запустить: `cd app && npm test -- tests/lib/firstSales/params.test.ts` — ожидаемо PASS, 8 тестов.

- [ ] **Step 3: Написать роут summary**

```typescript
// app/src/app/api/analytics/first-sales/summary/route.ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams } from '@/lib/firstSales/params';
import {
  computeFirstSalesSeries,
  fetchFirstSalesLeads,
  fetchSourceMap,
} from '@/lib/firstSales/metrics';

const PIPELINE_ID = Number(process.env.FIRST_SALES_PIPELINE_ID ?? '7670334');

export async function GET(req: NextRequest) {
  // `'error' in gate` — принятое в проекте сужение размеченного объединения
  // (см. src/app/api/database-review/requests/route.ts:15). Через `gate.error`
  // TypeScript union не сузит.
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;
  const db = gate.supabaseAdmin;

  const parsed = parseFirstSalesParams(new URL(req.url));
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to, groupBy, channels } = parsed.value;

  try {
    const [leads, sourceMap] = await Promise.all([
      fetchFirstSalesLeads(db, PIPELINE_ID, from, to),
      fetchSourceMap(db),
    ]);

    const result = computeFirstSalesSeries(leads, sourceMap, from, to, groupBy, channels);

    // Дата последнего успешного синка — на дашборд. Тихо устаревшие цифры хуже
    // отсутствующих: пользователь должен видеть, что данные вчерашние.
    const { data: lastRun } = await db
      .from('external_sync_runs')
      .select('finished_at')
      .eq('source', 'amo_events')
      .eq('status', 'success')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({ ...result, syncedAt: lastRun?.finished_at ?? null });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'first_sales_summary_failed' },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Написать роут справочника**

```typescript
// app/src/app/api/analytics/first-sales/source-map/route.ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { normalizeSource, type FirstSalesChannel } from '@/lib/firstSales/sourceChannels';

const CHANNELS: FirstSalesChannel[] = [
  'marketing', 'smm', 'outreach', 'partners',
  'tg_outreach', 'inbound', 'referral', 'events', 'unassigned',
];

export async function GET(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const { data, error } = await gate.supabaseAdmin
    .from('lead_source_channels')
    .select('id, source, channel, display_name, sort_order, updated_at')
    .order('sort_order');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rows: data ?? [] });
}

export async function PUT(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const body = (await req.json().catch(() => null)) as
    | { source?: unknown; channel?: unknown; display_name?: unknown }
    | null;
  const source = normalizeSource(typeof body?.source === 'string' ? body.source : null);
  const channel = body?.channel;

  if (!source) return NextResponse.json({ error: 'Пустой source' }, { status: 400 });
  if (typeof channel !== 'string' || !CHANNELS.includes(channel as FirstSalesChannel)) {
    return NextResponse.json({ error: `Недопустимый channel: ${String(channel)}` }, { status: 400 });
  }

  const { error } = await gate.supabaseAdmin
    .from('lead_source_channels')
    .upsert(
      {
        source,
        channel,
        display_name: typeof body?.display_name === 'string' ? body.display_name : null,
        updated_by: gate.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source' },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Проверить типы и прогнать весь пакет тестов**

```bash
cd app && npx tsc --noEmit && npm test -- tests/lib/firstSales
```

Ожидаемо: `tsc` чисто, все тесты `firstSales` зелёные.

- [ ] **Step 6: Закоммитить**

```bash
git add app/src/lib/firstSales/params.ts app/tests/lib/firstSales/params.test.ts app/src/app/api/analytics/first-sales
git commit -m "feat(first-sales): API сводки и справочника источников"
```

---

## Task 10: Страница дашборда

**Files:**
- Modify: `app/package.json` (зависимость `recharts`)
- Create: `app/src/app/analytics/first-sales/page.tsx`
- Create: `app/src/components/first-sales/FirstSalesView.tsx`
- Create: `app/src/components/first-sales/FiltersBar.tsx`
- Create: `app/src/components/first-sales/KpiRow.tsx`
- Create: `app/src/components/first-sales/TimeSeriesChart.tsx`
- Create: `app/src/components/first-sales/SourceTable.tsx`

- [ ] **Step 1: Поставить recharts**

```bash
cd app && npm install recharts@^2.15.0
```

Ожидаемо: `added N packages`, в `package.json` появилась строка `"recharts": "^2.15.0"`.

Если парная задача по расходам уже поставила recharts — шаг пропустить, версию не менять.

- [ ] **Step 2: Написать страницу-контейнер**

```typescript
// app/src/app/analytics/first-sales/page.tsx
import FirstSalesView from '@/components/first-sales/FirstSalesView';

export const metadata = { title: 'Первичка' };

export default function FirstSalesPage() {
  return <FirstSalesView />;
}
```

- [ ] **Step 3: Написать шапку фильтров**

```typescript
// app/src/components/first-sales/FiltersBar.tsx
'use client';

import type { GroupBy } from '@/lib/firstSales/buckets';
import { CHANNEL_LABELS, type FirstSalesChannel } from '@/lib/firstSales/sourceChannels';

const PRESETS: { id: string; label: string; days: number }[] = [
  { id: '30d', label: '30 дней', days: 30 },
  { id: '90d', label: 'Квартал', days: 90 },
  { id: '365d', label: 'Год', days: 365 },
];

const GROUP_LABELS: Record<GroupBy, string> = {
  day: 'День',
  week: 'Неделя',
  month: 'Месяц',
};

export type FiltersState = {
  from: string;
  to: string;
  groupBy: GroupBy;
  channels: FirstSalesChannel[];
};

export default function FiltersBar({
  value,
  onChange,
}: {
  value: FiltersState;
  onChange: (next: FiltersState) => void;
}) {
  const applyPreset = (days: number) => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    onChange({
      ...value,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    });
  };

  const toggleChannel = (channel: FirstSalesChannel) => {
    const next = value.channels.includes(channel)
      ? value.channels.filter((c) => c !== channel)
      : [...value.channels, channel];
    onChange({ ...value, channels: next });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 pb-3">
      <div className="flex items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyPreset(p.days)}
            className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
          >
            {p.label}
          </button>
        ))}
      </div>

      <input
        type="date"
        value={value.from}
        onChange={(e) => onChange({ ...value, from: e.target.value })}
        className="rounded border border-zinc-200 px-2 py-1 text-xs"
      />
      <span className="text-xs text-zinc-400">—</span>
      <input
        type="date"
        value={value.to}
        onChange={(e) => onChange({ ...value, to: e.target.value })}
        className="rounded border border-zinc-200 px-2 py-1 text-xs"
      />

      <div className="flex items-center gap-1 rounded border border-zinc-200 p-0.5">
        {(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => onChange({ ...value, groupBy: g })}
            className={
              value.groupBy === g
                ? 'rounded bg-zinc-900 px-2 py-0.5 text-xs text-white'
                : 'rounded px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50'
            }
          >
            {GROUP_LABELS[g]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {(Object.keys(CHANNEL_LABELS) as FirstSalesChannel[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => toggleChannel(c)}
            className={
              value.channels.includes(c)
                ? 'rounded-full bg-zinc-900 px-2.5 py-0.5 text-xs text-white'
                : 'rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50'
            }
          >
            {CHANNEL_LABELS[c]}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Написать KPI-строку**

```typescript
// app/src/components/first-sales/KpiRow.tsx
'use client';

import type { FirstSalesTotals } from '@/lib/firstSales/metrics';

function Card({
  label, value, sub, warn,
}: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div
      className={
        warn
          ? 'rounded border border-amber-300 bg-amber-50 px-3 py-2'
          : 'rounded border border-zinc-200 px-3 py-2'
      }
    >
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-900">{value}</div>
      {sub ? <div className="text-[11px] text-zinc-500">{sub}</div> : null}
    </div>
  );
}

const days = (v: number | null) => (v === null ? '—' : `${Math.round(v)} дн.`);

export default function KpiRow({
  totals, syncedAt,
}: { totals: FirstSalesTotals; syncedAt: string | null }) {
  const syncLabel = syncedAt
    ? new Date(syncedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    : 'нет данных';
  const stale =
    !syncedAt || Date.now() - new Date(syncedAt).getTime() > 36 * 60 * 60 * 1000;

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
      <Card label="Лиды" value={String(totals.leads)} sub={`магниты: ${totals.leadMagnets}`} />
      <Card label="Квал" value={String(totals.qualified)} />
      <Card label="Встречи" value={String(totals.meetings)} />
      <Card label="Договоры" value={String(totals.contracts)} />
      <Card
        label="Средний цикл"
        value={days(totals.cycleMedianDays)}
        sub={`среднее: ${days(totals.cycleAvgDays)} · оплат: ${totals.wonCount}`}
      />
      {/* Пока «без канала» большое — остальным числам верить нельзя,
          поэтому показатель стоит в одном ряду с метриками, а не в углу. */}
      <Card
        label="Без канала"
        value={String(totals.unassignedLeads)}
        warn={totals.unassignedLeads > 0}
      />
      <Card label="Данные на" value={syncLabel} warn={stale} />
    </div>
  );
}
```

- [ ] **Step 5: Написать график**

```typescript
// app/src/components/first-sales/TimeSeriesChart.tsx
'use client';

import {
  Bar, CartesianGrid, ComposedChart, Legend, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { SeriesBucket } from '@/lib/firstSales/metrics';

export default function TimeSeriesChart({ series }: { series: SeriesBucket[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid stroke="#f4f4f5" vertical={false} />
          <XAxis dataKey="key" tick={{ fontSize: 11 }} tickMargin={6} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="leads" name="Лиды" fill="#a1a1aa" radius={[2, 2, 0, 0]} />
          <Line dataKey="qualified" name="Квал" stroke="#0ea5e9" dot={false} strokeWidth={2} />
          <Line dataKey="meetings" name="Встречи" stroke="#10b981" dot={false} strokeWidth={2} />
          <Line dataKey="contracts" name="Договоры" stroke="#f59e0b" dot={false} strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 6: Написать таблицу источников**

Пока без раскрытия строк — drill-down добавляется в Task 13, когда появится роут `/leads`. Здесь нужна работающая таблица, чтобы страницу можно было открыть и проверить цифры.

```typescript
// app/src/components/first-sales/SourceTable.tsx
'use client';

import type { SourceBreakdown } from '@/lib/firstSales/metrics';
import { CHANNEL_LABELS } from '@/lib/firstSales/sourceChannels';

export default function SourceTable({ rows }: { rows: SourceBreakdown[] }) {
  const total = rows.reduce((sum, r) => sum + r.leads, 0);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
          <th className="py-2">Источник</th>
          <th className="py-2">Канал</th>
          <th className="py-2 text-right">Лиды</th>
          <th className="py-2 text-right">Доля</th>
          <th className="py-2 text-right">Квал</th>
          <th className="py-2 text-right">Встречи</th>
          <th className="py-2 text-right">Договоры</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.source} className="border-b border-zinc-100">
            <td className="py-1.5">
              {r.source}
              {/* Новый источник в AMO не должен потеряться молча. */}
              {!r.known ? (
                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
                  нет в справочнике
                </span>
              ) : null}
            </td>
            <td className="py-1.5 text-zinc-600">{CHANNEL_LABELS[r.channel]}</td>
            <td className="py-1.5 text-right tabular-nums">{r.leads}</td>
            <td className="py-1.5 text-right tabular-nums text-zinc-500">
              {total > 0 ? `${Math.round((r.leads / total) * 100)}%` : '—'}
            </td>
            <td className="py-1.5 text-right tabular-nums">{r.qualified}</td>
            <td className="py-1.5 text-right tabular-nums">{r.meetings}</td>
            <td className="py-1.5 text-right tabular-nums">{r.contracts}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 7: Собрать всё вместе**

```typescript
// app/src/components/first-sales/FirstSalesView.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';
import type { FirstSalesSeries } from '@/lib/firstSales/metrics';
import FiltersBar, { type FiltersState } from './FiltersBar';
import KpiRow from './KpiRow';
import TimeSeriesChart from './TimeSeriesChart';
import SourceTable from './SourceTable';

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () =>
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

type Payload = FirstSalesSeries & { syncedAt: string | null };

export default function FirstSalesView() {
  const [filters, setFilters] = useState<FiltersState>({
    from: monthAgo(),
    to: today(),
    groupBy: 'day',
    channels: [],
  });
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const params = new URLSearchParams({
        from: filters.from,
        to: filters.to,
        groupBy: filters.groupBy,
      });
      for (const c of filters.channels) params.append('channel', c);

      const res = await fetch(`/api/analytics/first-sales/summary?${params}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as Payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось загрузить данные';
      setError(message);
      logError('first-sales summary failed', e);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold text-zinc-900">Первичка</h1>

      <FiltersBar value={filters} onChange={setFilters} />

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="py-12 text-center text-sm text-zinc-500">Загрузка…</div>
      ) : null}

      {data ? (
        <>
          <KpiRow totals={data.totals} syncedAt={data.syncedAt} />
          <TimeSeriesChart series={data.series} />
          <SourceTable rows={data.bySource} />
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 8: Проверить типы и сборку**

```bash
cd app && npx tsc --noEmit && npm run lint
```

Ожидаемо: обе команды без ошибок.

- [ ] **Step 9: Проверить страницу вживую**

Запустить дев-сервер через preview-инструменты (не через Bash), открыть `/analytics/first-sales`, убедиться: KPI заполнены, график рисуется, таблица источников непустая, в консоли браузера нет ошибок.

- [ ] **Step 10: Закоммитить**

```bash
git add app/package.json app/package-lock.json app/src/app/analytics/first-sales app/src/components/first-sales
git commit -m "feat(first-sales): страница дашборда первички"
```

---

## Task 11: Экран справочника источников

**Files:**
- Create: `app/src/components/first-sales/SourceMapEditor.tsx`
- Modify: `app/src/components/first-sales/FirstSalesView.tsx`

- [ ] **Step 1: Написать редактор справочника**

```typescript
// app/src/components/first-sales/SourceMapEditor.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';
import { CHANNEL_LABELS, type FirstSalesChannel } from '@/lib/firstSales/sourceChannels';

type Row = {
  id: number;
  source: string;
  channel: FirstSalesChannel;
  display_name: string | null;
  sort_order: number;
};

export default function SourceMapEditor({ onSaved }: { onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savingSource, setSavingSource] = useState<string | null>(null);

  const authHeader = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${session?.access_token ?? ''}` };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/analytics/first-sales/source-map', {
        headers: await authHeader(),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setRows(body.rows as Row[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить справочник');
      logError('first-sales source-map load failed', e);
    }
  }, [authHeader]);

  useEffect(() => { void load(); }, [load]);

  const save = async (row: Row, channel: FirstSalesChannel) => {
    setSavingSource(row.source);
    setError(null);
    try {
      const res = await fetch('/api/analytics/first-sales/source-map', {
        method: 'PUT',
        headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: row.source,
          channel,
          display_name: row.display_name,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setRows((prev) =>
        prev.map((r) => (r.source === row.source ? { ...r, channel } : r)),
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
      logError('first-sales source-map save failed', e);
    } finally {
      setSavingSource(null);
    }
  };

  // Нераспределённые — наверх: это очередь работы, а не справочная информация.
  const sorted = [...rows].sort((a, b) => {
    const aU = a.channel === 'unassigned' ? 0 : 1;
    const bU = b.channel === 'unassigned' ? 0 : 1;
    return aU - bU || a.sort_order - b.sort_order;
  });

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-900">Источник → канал</h2>
      {error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}
      <table className="w-full text-sm">
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.source}
              className={
                r.channel === 'unassigned'
                  ? 'border-b border-zinc-100 bg-amber-50/60'
                  : 'border-b border-zinc-100'
              }
            >
              <td className="py-1.5">{r.display_name ?? r.source}</td>
              <td className="w-48 py-1.5 text-right">
                <select
                  value={r.channel}
                  disabled={savingSource === r.source}
                  onChange={(e) => void save(r, e.target.value as FirstSalesChannel)}
                  className="rounded border border-zinc-200 px-2 py-1 text-xs"
                >
                  {(Object.keys(CHANNEL_LABELS) as FirstSalesChannel[]).map((c) => (
                    <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Подключить редактор к странице**

В `app/src/components/first-sales/FirstSalesView.tsx` добавить импорт:

```typescript
import SourceMapEditor from './SourceMapEditor';
```

добавить состояние рядом с остальными:

```typescript
  const [showMap, setShowMap] = useState(false);
```

и вставить перед закрывающим `</div>` компонента:

```typescript
      <div className="pt-2">
        <button
          type="button"
          onClick={() => setShowMap((v) => !v)}
          className="text-xs text-zinc-600 underline hover:text-zinc-900"
        >
          {showMap ? 'Скрыть справочник источников' : 'Справочник источников'}
        </button>
        {showMap ? (
          <div className="mt-3 rounded border border-zinc-200 p-3">
            <SourceMapEditor onSaved={() => void load()} />
          </div>
        ) : null}
      </div>
```

- [ ] **Step 3: Проверить типы и линт**

```bash
cd app && npx tsc --noEmit && npm run lint
```

Ожидаемо: без ошибок.

- [ ] **Step 4: Проверить вживую**

Открыть `/analytics/first-sales`, раскрыть справочник, сменить канал у любого источника из «Не распределено», убедиться: строка уходит вниз списка, KPI «Без канала» уменьшается, ошибок в консоли нет.

- [ ] **Step 5: Закоммитить**

```bash
git add app/src/components/first-sales
git commit -m "feat(first-sales): экран справочника «источник → канал»"
```

---

## Task 12: Δ к предыдущему периоду

Спека обещает у каждой метрики дельту к предыдущему периоду того же размера. Без неё цифра «91 встреча» не говорит ничего: неясно, много это или мало.

**Files:**
- Modify: `app/src/lib/firstSales/params.ts` (функция `previousWindow`)
- Modify: `app/src/app/api/analytics/first-sales/summary/route.ts`
- Modify: `app/src/components/first-sales/KpiRow.tsx`
- Test: `app/tests/lib/firstSales/params.test.ts` (дописать блок)

- [ ] **Step 1: Дописать падающий тест**

Добавить в конец `app/tests/lib/firstSales/params.test.ts`:

```typescript
import { previousWindow } from '@/lib/firstSales/params';

describe('previousWindow', () => {
  it('сдвигает окно назад ровно на его длину', () => {
    const from = new Date('2026-07-01T00:00:00.000Z');
    const to = new Date('2026-07-31T00:00:00.000Z');
    const prev = previousWindow(from, to);
    expect(prev.to.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(prev.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('работает на окне в один день', () => {
    const from = new Date('2026-07-15T00:00:00.000Z');
    const to = new Date('2026-07-15T23:59:59.999Z');
    const prev = previousWindow(from, to);
    expect(prev.from.toISOString()).toBe('2026-07-14T00:00:00.001Z');
    expect(prev.to.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });
});
```

Запустить — должно упасть с `previousWindow is not a function`:

```bash
cd app && npm test -- tests/lib/firstSales/params.test.ts
```

- [ ] **Step 2: Реализовать `previousWindow`**

Добавить в конец `app/src/lib/firstSales/params.ts`:

```typescript
/** Предыдущее окно той же длины, вплотную к текущему. Нужно для Δ:
 *  сравнивать июль с июнем корректно только при равной длине окон. */
export function previousWindow(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  return {
    from: new Date(from.getTime() - span),
    to: new Date(from.getTime()),
  };
}
```

Запустить — PASS.

- [ ] **Step 3: Отдавать предыдущие итоги из роута**

В `app/src/app/api/analytics/first-sales/summary/route.ts` заменить импорт параметров:

```typescript
import { parseFirstSalesParams, previousWindow } from '@/lib/firstSales/params';
```

и заменить блок вычисления результата:

```typescript
    const result = computeFirstSalesSeries(leads, sourceMap, from, to, groupBy, channels);
```

на:

```typescript
    const result = computeFirstSalesSeries(leads, sourceMap, from, to, groupBy, channels);

    // Предыдущее окно тянем отдельным запросом: расширять текущее нельзя —
    // ряд по времени раздуется вдвое и график покажет лишнее.
    const prev = previousWindow(from, to);
    const prevLeads = await fetchFirstSalesLeads(db, PIPELINE_ID, prev.from, prev.to);
    const prevResult = computeFirstSalesSeries(
      prevLeads, sourceMap, prev.from, prev.to, groupBy, channels,
    );
```

и заменить возврат:

```typescript
    return NextResponse.json({ ...result, syncedAt: lastRun?.finished_at ?? null });
```

на:

```typescript
    return NextResponse.json({
      ...result,
      previousTotals: prevResult.totals,
      syncedAt: lastRun?.finished_at ?? null,
    });
```

- [ ] **Step 4: Показать Δ в KPI**

В `app/src/components/first-sales/KpiRow.tsx` заменить компонент `Card` и сигнатуру `KpiRow`:

```typescript
function Delta({ current, previous }: { current: number; previous: number }) {
  const diff = current - previous;
  if (previous === 0 && diff === 0) return null;
  const sign = diff > 0 ? '+' : '';
  const tone = diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-red-600' : 'text-zinc-400';
  const pct = previous === 0 ? null : Math.round((diff / previous) * 100);
  return (
    <span className={`text-[11px] ${tone}`}>
      {sign}{diff}{pct === null ? '' : ` (${sign}${pct}%)`}
    </span>
  );
}

function Card({
  label, value, sub, warn, current, previous,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
  current?: number;
  previous?: number;
}) {
  return (
    <div
      className={
        warn
          ? 'rounded border border-amber-300 bg-amber-50 px-3 py-2'
          : 'rounded border border-zinc-200 px-3 py-2'
      }
    >
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-lg font-semibold text-zinc-900">{value}</span>
        {current !== undefined && previous !== undefined ? (
          <Delta current={current} previous={previous} />
        ) : null}
      </div>
      {sub ? <div className="text-[11px] text-zinc-500">{sub}</div> : null}
    </div>
  );
}
```

и в теле `KpiRow` заменить сигнатуру и четыре первые карточки:

```typescript
export default function KpiRow({
  totals, previousTotals, syncedAt,
}: {
  totals: FirstSalesTotals;
  previousTotals: FirstSalesTotals | null;
  syncedAt: string | null;
}) {
```

```typescript
      <Card
        label="Лиды" value={String(totals.leads)}
        sub={`магниты: ${totals.leadMagnets}`}
        current={totals.leads} previous={previousTotals?.leads}
      />
      <Card
        label="Квал" value={String(totals.qualified)}
        current={totals.qualified} previous={previousTotals?.qualified}
      />
      <Card
        label="Встречи" value={String(totals.meetings)}
        current={totals.meetings} previous={previousTotals?.meetings}
      />
      <Card
        label="Договоры" value={String(totals.contracts)}
        current={totals.contracts} previous={previousTotals?.contracts}
      />
```

В `app/src/components/first-sales/FirstSalesView.tsx` расширить тип payload:

```typescript
type Payload = FirstSalesSeries & {
  previousTotals: FirstSalesTotals | null;
  syncedAt: string | null;
};
```

добавить `FirstSalesTotals` в импорт типов из `@/lib/firstSales/metrics` и передать проп:

```typescript
          <KpiRow
            totals={data.totals}
            previousTotals={data.previousTotals}
            syncedAt={data.syncedAt}
          />
```

- [ ] **Step 5: Проверить**

```bash
cd app && npx tsc --noEmit && npm test -- tests/lib/firstSales && npm run lint
```

Ожидаемо: всё зелёное. Затем открыть страницу и убедиться, что под числами появились дельты, а на пустом предыдущем периоде ничего не ломается.

- [ ] **Step 6: Закоммитить**

```bash
git add app/src/lib/firstSales/params.ts app/tests/lib/firstSales/params.test.ts app/src/app/api/analytics/first-sales/summary/route.ts app/src/components/first-sales
git commit -m "feat(first-sales): дельта к предыдущему периоду в KPI"
```

---

## Task 13: Drill-down по источнику

Спека требует: клик по строке источника раскрывает сделки со ссылками в AMO. Это не украшение — без возможности провалиться в цифру дашборду не поверят, а первое же расхождение с AMO станет неразрешимым спором.

**Files:**
- Create: `app/src/app/api/analytics/first-sales/leads/route.ts`
- Modify: `app/src/components/first-sales/SourceTable.tsx`

- [ ] **Step 1: Написать роут drill-down**

```typescript
// app/src/app/api/analytics/first-sales/leads/route.ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams } from '@/lib/firstSales/params';
import { fetchFirstSalesLeads, fetchSourceMap } from '@/lib/firstSales/metrics';
import { buildSourceIndex, resolveChannel } from '@/lib/firstSales/sourceChannels';

const PIPELINE_ID = Number(process.env.FIRST_SALES_PIPELINE_ID ?? '7670334');
const AMO_BASE = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '');
const MAX_ROWS = 200;

export async function GET(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const url = new URL(req.url);
  const parsed = parseFirstSalesParams(url);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to, channels } = parsed.value;

  // Пустая строка — валидный источник: это сделки без заполненного «Источник».
  const source = url.searchParams.get('source');
  if (source === null) {
    return NextResponse.json({ error: 'Нужен параметр source' }, { status: 400 });
  }

  try {
    const [leads, sourceMap] = await Promise.all([
      fetchFirstSalesLeads(gate.supabaseAdmin, PIPELINE_ID, from, to),
      fetchSourceMap(gate.supabaseAdmin),
    ]);
    const index = buildSourceIndex(sourceMap);
    const allowed = channels && channels.length > 0 ? new Set(channels) : null;

    const rows = leads
      .filter((lead) => {
        const resolved = resolveChannel(lead.raw, index);
        if (allowed && !allowed.has(resolved.channel)) return false;
        return (resolved.source || '(не указан)') === source;
      })
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      .slice(0, MAX_ROWS)
      .map((lead) => ({
        amo_id: lead.amo_id,
        name: lead.name,
        created_at: lead.created_at,
        first_meeting_at: lead.first_meeting_at,
        first_contract_at: lead.first_contract_at,
        won_at: lead.won_at,
        history_complete: lead.history_complete,
        amo_url: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
      }));

    // Срез в 200 строк — не «столько и есть». Отдаём флаг, чтобы UI сказал правду.
    return NextResponse.json({ rows, truncated: rows.length === MAX_ROWS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'first_sales_leads_failed' },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Раскрыть строку в таблице источников**

Заменить `app/src/components/first-sales/SourceTable.tsx` целиком:

```typescript
'use client';

import { Fragment, useCallback, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';
import type { SourceBreakdown } from '@/lib/firstSales/metrics';
import { CHANNEL_LABELS } from '@/lib/firstSales/sourceChannels';
import type { FiltersState } from './FiltersBar';

type LeadRow = {
  amo_id: number;
  name: string | null;
  created_at: string | null;
  first_meeting_at: string | null;
  first_contract_at: string | null;
  won_at: string | null;
  history_complete: boolean;
  amo_url: string | null;
};

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—';

export default function SourceTable({
  rows, filters,
}: { rows: SourceBreakdown[]; filters: FiltersState }) {
  const total = rows.reduce((sum, r) => sum + r.leads, 0);
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDrilldown = useCallback(async (source: string) => {
    if (openSource === source) {
      setOpenSource(null);
      return;
    }
    setOpenSource(source);
    setLeads([]);
    setError(null);
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const params = new URLSearchParams({
        from: filters.from,
        to: filters.to,
        groupBy: filters.groupBy,
        source,
      });
      for (const c of filters.channels) params.append('channel', c);

      const res = await fetch(`/api/analytics/first-sales/leads?${params}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setLeads(body.rows as LeadRow[]);
      setTruncated(Boolean(body.truncated));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить сделки');
      logError('first-sales drilldown failed', e);
    } finally {
      setLoading(false);
    }
  }, [filters, openSource]);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
          <th className="py-2">Источник</th>
          <th className="py-2">Канал</th>
          <th className="py-2 text-right">Лиды</th>
          <th className="py-2 text-right">Доля</th>
          <th className="py-2 text-right">Квал</th>
          <th className="py-2 text-right">Встречи</th>
          <th className="py-2 text-right">Договоры</th>
        </tr>
      </thead>
      <tbody>
        {/* Fragment с key, а не `<>`: сокращённая форма фрагмента key не принимает,
            а строка + раскрытые детали — два соседних <tr> на один источник. */}
        {rows.map((r) => (
          <Fragment key={r.source}>
            <tr
              onClick={() => void openDrilldown(r.source)}
              className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50"
            >
              <td className="py-1.5">
                <span className="mr-1 text-zinc-400">{openSource === r.source ? '▾' : '▸'}</span>
                {r.source}
                {!r.known ? (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
                    нет в справочнике
                  </span>
                ) : null}
              </td>
              <td className="py-1.5 text-zinc-600">{CHANNEL_LABELS[r.channel]}</td>
              <td className="py-1.5 text-right tabular-nums">{r.leads}</td>
              <td className="py-1.5 text-right tabular-nums text-zinc-500">
                {total > 0 ? `${Math.round((r.leads / total) * 100)}%` : '—'}
              </td>
              <td className="py-1.5 text-right tabular-nums">{r.qualified}</td>
              <td className="py-1.5 text-right tabular-nums">{r.meetings}</td>
              <td className="py-1.5 text-right tabular-nums">{r.contracts}</td>
            </tr>

            {openSource === r.source ? (
              <tr className="border-b border-zinc-100 bg-zinc-50/60">
                <td colSpan={7} className="px-3 py-2">
                  {loading ? <div className="text-xs text-zinc-500">Загрузка…</div> : null}
                  {error ? <div className="text-xs text-red-700">{error}</div> : null}
                  {!loading && !error && leads.length === 0 ? (
                    <div className="text-xs text-zinc-500">Нет сделок в этом периоде.</div>
                  ) : null}
                  {leads.length > 0 ? (
                    <>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-zinc-500">
                            <th className="py-1">Сделка</th>
                            <th className="py-1">Создана</th>
                            <th className="py-1">Встреча</th>
                            <th className="py-1">Договор</th>
                            <th className="py-1">Оплата</th>
                          </tr>
                        </thead>
                        <tbody>
                          {leads.map((l) => (
                            <tr key={l.amo_id}>
                              <td className="py-1">
                                {l.amo_url ? (
                                  <a
                                    href={l.amo_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-sky-700 underline"
                                  >
                                    {l.name ?? `Сделка ${l.amo_id}`}
                                  </a>
                                ) : (
                                  (l.name ?? `Сделка ${l.amo_id}`)
                                )}
                                {!l.history_complete ? (
                                  <span
                                    className="ml-2 text-[10px] text-amber-700"
                                    title="Сделка создана раньше глубины истории AMO — её этапы не считаются"
                                  >
                                    история неполная
                                  </span>
                                ) : null}
                              </td>
                              <td className="py-1 tabular-nums">{shortDate(l.created_at)}</td>
                              <td className="py-1 tabular-nums">{shortDate(l.first_meeting_at)}</td>
                              <td className="py-1 tabular-nums">{shortDate(l.first_contract_at)}</td>
                              <td className="py-1 tabular-nums">{shortDate(l.won_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {truncated ? (
                        <div className="pt-1 text-[11px] text-amber-700">
                          Показаны первые 200 сделок — список обрезан.
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </td>
              </tr>
            ) : null}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Передать фильтры в таблицу**

В `app/src/components/first-sales/FirstSalesView.tsx` заменить рендер таблицы:

```typescript
          <SourceTable rows={data.bySource} />
```

на:

```typescript
          <SourceTable rows={data.bySource} filters={filters} />
```

- [ ] **Step 4: Проверить**

```bash
cd app && npx tsc --noEmit && npm run lint
```

Ожидаемо: без ошибок. Затем открыть страницу, кликнуть по строке источника: раскрывается список сделок, ссылка ведёт в AMO на нужную сделку, повторный клик сворачивает.

- [ ] **Step 5: Закоммитить**

```bash
git add app/src/app/api/analytics/first-sales/leads app/src/components/first-sales
git commit -m "feat(first-sales): drill-down по источнику со ссылками в AMO"
```

---

## Task 14: Сверка с ручным отчётом продаж

Дашборд считает иначе, чем отчёт Егора, и это заложено. Задача — доказать, что расхождения объясняются **ровно двумя** принятыми решениями, а не третьей причиной, о которой мы не знаем.

**Files:**
- Create: `app/scripts/first-sales-reconcile.mjs`

- [ ] **Step 1: Написать скрипт сверки**

```javascript
// app/scripts/first-sales-reconcile.mjs
// Сверка дашборда первички с логикой отчёта продаж за июль 2026.
// Расхождения обязаны объясняться двумя решениями спеки:
//   1. дашборд НЕ выбрасывает мёртвые сделки (status_id=143);
//   2. дашборд НЕ выбрасывает лид-магниты (имя с префиксом «Бот:»).
// Любое третье расхождение — баг.
// Запуск: node scripts/first-sales-reconcile.mjs 2026-07-01 2026-07-31
import 'dotenv/config';
import pg from 'pg';

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('Использование: node scripts/first-sales-reconcile.mjs YYYY-MM-DD YYYY-MM-DD');
  process.exit(1);
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const PIPELINE = 7670334;

const { rows } = await c.query(
  `
  with win as (select $1::date as f, ($2::date + 1) as t),
  base as (
    select l.amo_id, l.name, l.status_id, l.created_at,
           s.first_meeting_at, s.first_contract_at, s.history_complete
    from amo_leads l
    join amo_lead_stage_dates_v s on s.amo_deal_id = l.amo_id
    where l.pipeline_id = $3
  )
  select
    -- Отчёт продаж: пришедшие в окне, живые, без магнитов
    count(*) filter (
      where created_at >= (select f from win) and created_at < (select t from win)
        and status_id <> 143 and name not like 'Бот:%'
    ) as report_leads,
    -- Дашборд: все пришедшие в окне
    count(*) filter (
      where created_at >= (select f from win) and created_at < (select t from win)
    ) as dashboard_leads,
    -- Разница, разложенная на две объявленные причины
    count(*) filter (
      where created_at >= (select f from win) and created_at < (select t from win)
        and status_id = 143
    ) as diff_lost,
    count(*) filter (
      where created_at >= (select f from win) and created_at < (select t from win)
        and status_id <> 143 and name like 'Бот:%'
    ) as diff_magnets,
    count(*) filter (
      where history_complete
        and first_meeting_at >= (select f from win) and first_meeting_at < (select t from win)
    ) as dashboard_meetings,
    count(*) filter (
      where history_complete
        and first_contract_at >= (select f from win) and first_contract_at < (select t from win)
    ) as dashboard_contracts
  from base`,
  [from, to, PIPELINE],
);

const r = rows[0];
const explained = Number(r.report_leads) + Number(r.diff_lost) + Number(r.diff_magnets);

console.log('Период:', from, '→', to);
console.log('Лиды по логике отчёта продаж :', r.report_leads);
console.log('Лиды по логике дашборда      :', r.dashboard_leads);
console.log('  из них мёртвые (143)       :', r.diff_lost);
console.log('  из них лид-магниты         :', r.diff_magnets);
console.log('Встречи (дашборд)            :', r.dashboard_meetings);
console.log('Договоры (дашборд)           :', r.dashboard_contracts);
console.log('');

if (explained === Number(r.dashboard_leads)) {
  console.log('OK: расхождение объясняется полностью двумя решениями спеки.');
} else {
  console.log(
    `ПРОВАЛ: необъяснённая разница ${Number(r.dashboard_leads) - explained} сделок. Разбираться.`,
  );
  process.exitCode = 1;
}

await c.end();
```

- [ ] **Step 2: Запустить сверку за июль**

```bash
cd app && node scripts/first-sales-reconcile.mjs 2026-07-01 2026-07-31
```

Ожидаемо: последняя строка `OK: расхождение объясняется полностью двумя решениями спеки.` Если `ПРОВАЛ` — не переходить дальше, искать третью причину.

- [ ] **Step 3: Сверить встречи и договоры с ручным отчётом глазами**

Открыть «Отчетность продаж Polza Agency», лист «Июль 2026», блок «ИТОГО ПО ОТДЕЛУ», колонка МЕСЯЦ: строки «встреч» и «договоров». Сравнить с выводом скрипта.

Числа **не обязаны** совпадать: отчёт считает когортно («из пришедших в июле дошли до встречи»), дашборд — по дате перехода. Ожидаемо, что дашборд покажет больше, потому что засчитывает встречи по июньским и майским сделкам, состоявшиеся в июле. Записать оба числа в спеку, раздел «Открытые вопросы», пункт 3 — это исходные данные для будущего перевода отчёта продаж.

- [ ] **Step 4: Прогнать весь пакет тестов**

```bash
cd app && npm test
```

Ожидаемо: вся сюита зелёная. Если упали чужие тесты — чинить до коммита, красную сюиту не оставлять.

- [ ] **Step 5: Закоммитить**

```bash
git add app/scripts/first-sales-reconcile.mjs docs/superpowers/specs/2026-07-30-first-sales-dashboard-design.md
git commit -m "test(first-sales): сверка дашборда с логикой отчёта продаж"
```

---

## Что остаётся за рамками этапа 1

- Оборот и средний чек — этап 2, привязка приходов к сделкам по ИНН.
- Стоимость лида — этап 3, поверх разметки расходов из парной задачи.
- Перевод отчёта продаж на справочник и историю этапов — отдельная задача, требует согласования с продажами: привычные цифры изменятся.
- Раскладка спорных источников по каналам — не код, а решение Егора и Никиты в UI справочника. **Без неё запускаться нельзя**: 969 сделок за 2026 останутся в «Не распределено».
