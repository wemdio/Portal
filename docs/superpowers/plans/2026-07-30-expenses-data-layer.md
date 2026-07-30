# Расходы: слой данных — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Завести в базе расходы: дебет банков, сырьё Brocard, ручные траты, курсы ЦБ и словарь разметки — так, чтобы сумму расходов за месяц с разбивкой по сервисам можно было получить одним SQL-запросом.

**Architecture:** Сырьё по источникам остаётся честным и переливается ночным синком; разметка живёт в отдельной таблице и синком не затирается. Правила разметки применяются SQL-функцией `apply_expense_rules()`, которую зовут и ночной синк, и API — одна реализация на два вызова. Витрина `expenses_v` склеивает четыре источника, разметку и курс валюты.

**Tech Stack:** Postgres (Supabase migrations), Python 3.11 + asyncpg + httpx (`services/portal-external-sync`), pytest.

**Спека:** `docs/superpowers/specs/2026-07-30-expenses-dashboard-design.md`

---

## Ориентация в коде

Сервис синка — `services/portal-external-sync/`:

- `main.py` — APScheduler, список `SOURCES`, цикл `run_all()`. Источник, поднявший `NotImplementedError`, логируется как `partial` и не валит остальные (`main.py:84`).
- `sources/base.py` — базовый класс `SyncSource` с полем `name` и методом `run(conn) -> int`.
- `sources/_bank_common.py` — общий классификатор выручки и парсер дат для Точки и Т-Банка.
- `db.py` — `log_run_start` / `log_run_finish` в таблицу `external_sync_runs`.

Миграции — `supabase/migrations/`, применяются командой из каталога `app/`:

```bash
npm run db:migrate
```

Питоновские тесты в репозитории уже есть у соседнего сервиса (`services/instantly-sync-bot/pytest.ini`, `requirements-dev.txt`, `test_main.py`) — берём ту же схему.

---

## Структура файлов

**Создаём:**

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260730_0001_expenses_core.sql` | Таблицы разметки, сырьё Brocard и ручных трат, курсы, индексы, RLS, расширение CHECK на `external_sync_runs.source` |
| `supabase/migrations/20260730_0002_expenses_view.sql` | Витрина `expenses_v` |
| `supabase/migrations/20260730_0003_apply_expense_rules.sql` | Функция `apply_expense_rules(uuid)` |
| `services/portal-external-sync/pytest.ini` | Конфиг pytest |
| `services/portal-external-sync/requirements-dev.txt` | pytest и respx |
| `services/portal-external-sync/tests/test_bank_mapping.py` | Тесты чистого маппинга банковских операций |
| `services/portal-external-sync/tests/test_fx_cbr.py` | Тесты парсера XML ЦБ |
| `services/portal-external-sync/sources/fx_cbr.py` | Курсы ЦБ → `fx_rates` |
| `services/portal-external-sync/sources/expense_rules.py` | Вызов `apply_expense_rules()` |
| `services/portal-external-sync/sources/brocard.py` | Адаптер Brocard (скелет до выдачи ключей) |

**Правим:**

| Файл | Что |
|---|---|
| `services/portal-external-sync/sources/_bank_common.py` | Порядок колонок `bank_transactions` и `to_row()` |
| `services/portal-external-sync/sources/bank_tochka.py` | Чистый `map_transaction`, дебет наравне с кредитом |
| `services/portal-external-sync/sources/bank_tbank.py` | Дебет наравне с кредитом |
| `services/portal-external-sync/main.py` | Новые источники в `SOURCES` |

---

### Task 1: Миграция — таблицы, индексы, RLS

**Files:**
- Create: `supabase/migrations/20260730_0001_expenses_core.sql`

- [ ] **Step 1: Написать миграцию**

Создать файл `supabase/migrations/20260730_0001_expenses_core.sql`:

```sql
-- Расходы: сырьё по источникам + отдельный слой разметки.
-- Дизайн: docs/superpowers/specs/2026-07-30-expenses-dashboard-design.md
--
-- Принцип тот же, что в 20260706_0003_create_external_sync_tables.sql: сырьё
-- честное, трактовки отдельно. Ночной синк переливает сырьё каждый день и
-- физически не может затереть разметку, сделанную руками, — она в другой
-- таблице.

-- ─── Вендоры ─────────────────────────────────────────────────────────────

create table if not exists public.expense_vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text not null check (category in (
               'payroll','marketing','tools','taxes','operations','transfer','other')),
  is_active  boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_expense_vendors_name
  on public.expense_vendors (lower(name));
create index if not exists idx_expense_vendors_category
  on public.expense_vendors (category);

comment on table public.expense_vendors is
  'Получатель расхода (OpenAI, Instantly, Яндекс.Директ) и его категория.';
comment on column public.expense_vendors.category is
  'transfer — внутреннее перемещение (пополнение Brocard, возмещение подотчёта, перевод между счетами). В сумму расходов не входит, но видно в списке.';

-- ─── Правила разметки ────────────────────────────────────────────────────

create table if not exists public.expense_rules (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.expense_vendors(id) on delete cascade,
  match_field text not null check (match_field in ('payee_name','payee_inn','purpose','merchant')),
  match_type  text not null check (match_type in ('exact','contains')),
  pattern     text not null check (length(btrim(pattern)) >= 3),
  source      text check (source in ('tochka','tbank','brocard','manual')),
  priority    integer not null default 100,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create unique index if not exists uq_expense_rules_pattern
  on public.expense_rules (match_field, match_type, lower(btrim(pattern)), coalesce(source, ''));
create index if not exists idx_expense_rules_priority
  on public.expense_rules (priority, created_at);

comment on table public.expense_rules is
  'Правило «поле + тип совпадения + образец → вендор». source=NULL — правило для любого источника. Меньший priority выигрывает.';
comment on column public.expense_rules.pattern is
  'Минимум 3 значащих символа: короткий contains-образец совпал бы почти со всем и размёл бы разметку.';

-- ─── Разметка ────────────────────────────────────────────────────────────

create table if not exists public.expense_classifications (
  id            bigserial primary key,
  source        text not null check (source in ('tochka','tbank','brocard','manual')),
  source_ref    text not null,
  vendor_id     uuid not null references public.expense_vendors(id) on delete restrict,
  method        text not null check (method in ('rule','manual')),
  rule_id       uuid references public.expense_rules(id) on delete set null,
  classified_by uuid references public.profiles(id) on delete set null,
  classified_at timestamptz not null default now(),
  unique (source, source_ref)
);

create index if not exists idx_expense_class_vendor
  on public.expense_classifications (vendor_id);

comment on table public.expense_classifications is
  'Какая транзакция каким вендором размечена. method=manual защищено от пересчёта правил условием в apply_expense_rules().';

-- ─── Сырьё Brocard ───────────────────────────────────────────────────────

create table if not exists public.brocard_transactions (
  id                bigserial primary key,
  external_id       text not null unique,
  card_id           text,
  card_label        text,
  holder            text,
  occurred_at       timestamptz not null,
  amount            numeric(14,2) not null,
  currency          text not null,
  amount_account    numeric(14,2),
  currency_account  text,
  merchant          text,
  merchant_category text,
  status            text,
  raw               jsonb not null,
  synced_at         timestamptz not null default now()
);

create index if not exists idx_brocard_tx_occurred_at
  on public.brocard_transactions (occurred_at desc);
create index if not exists idx_brocard_tx_merchant
  on public.brocard_transactions (lower(merchant));

comment on column public.brocard_transactions.amount is
  'Сумма в валюте операции. amount_account — сколько списалось со счёта, если API отдаёт.';

-- ─── Ручные траты ────────────────────────────────────────────────────────

create table if not exists public.manual_expenses (
  id          uuid primary key default gen_random_uuid(),
  occurred_on date not null,
  amount      numeric(14,2) not null check (amount > 0),
  currency    text not null default 'RUB',
  payer       text not null default 'ceo_personal_card',
  comment     text,
  created_by  uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_manual_expenses_occurred_on
  on public.manual_expenses (occurred_on desc);
create index if not exists idx_manual_expenses_created_by
  on public.manual_expenses (created_by);

comment on table public.manual_expenses is
  'Траты, которых нет ни в одном API: в первую очередь личная карта CEO. Вендор здесь не хранится — разметка идёт через expense_classifications с source=manual.';

-- ─── Курсы ЦБ ────────────────────────────────────────────────────────────

create table if not exists public.fx_rates (
  rate_date  date not null,
  currency   text not null,
  rate       numeric(18,6) not null check (rate > 0),
  source     text not null default 'cbr',
  fetched_at timestamptz not null default now(),
  primary key (rate_date, currency)
);

comment on column public.fx_rates.rate is
  'Рублей за 1 единицу валюты — Value уже поделён на Nominal (у CNY Nominal=10).';
comment on table public.fx_rates is
  'Курсы ЦБ на дату публикации. Строки исторические и неизменяемые: рублёвый эквивалент, посчитанный витриной на лету, задним числом не плывёт.';

-- ─── Индексы под расходную сторону bank_transactions ─────────────────────
-- До этой задачи таблица использовалась только для прихода, поэтому
-- проиндексирован был только плательщик.

create index if not exists idx_bank_tx_payee_inn
  on public.bank_transactions (payee_inn) where payee_inn is not null;
create index if not exists idx_bank_tx_payee_name
  on public.bank_transactions (lower(payee_name));
create index if not exists idx_bank_tx_direction_date
  on public.bank_transactions (direction, occurred_at desc);

-- ─── Новые источники в логе синка ────────────────────────────────────────
-- external_sync_runs.source — CHECK со списком имён. Новое имя без правки
-- этого констрейнта роняет log_run_start(), который в main.py вызывается ВНЕ
-- try/except, то есть падает весь цикл синка, а не один источник.
-- Список продолжает актуальный из 20260723_0002_leads_report_summary.sql.

alter table public.external_sync_runs
  drop constraint if exists external_sync_runs_source_check;

alter table public.external_sync_runs
  add constraint external_sync_runs_source_check
  check (source in (
    'metrika',
    'amo_leads',
    'amo_events',
    'bank_tochka',
    'bank_tbank',
    'attribution',
    'amo_enrich',
    'leads_report_marketing',
    'leads_report_outreach',
    'leads_report_summary',
    'brocard',
    'fx_cbr',
    'expense_rules'
  ));

-- ─── RLS ─────────────────────────────────────────────────────────────────
-- Осознанно БЕЗ select-политики для authenticated: расходы читает только
-- серверный код под service_role через API-роуты с гардом доступа.

alter table public.expense_vendors          enable row level security;
alter table public.expense_rules            enable row level security;
alter table public.expense_classifications  enable row level security;
alter table public.brocard_transactions     enable row level security;
alter table public.manual_expenses          enable row level security;
alter table public.fx_rates                 enable row level security;

grant all on public.expense_vendors         to service_role, postgres;
grant all on public.expense_rules           to service_role, postgres;
grant all on public.expense_classifications to service_role, postgres;
grant all on public.brocard_transactions    to service_role, postgres;
grant all on public.manual_expenses         to service_role, postgres;
grant all on public.fx_rates                to service_role, postgres;

grant usage, select on sequence public.expense_classifications_id_seq to service_role, postgres;
grant usage, select on sequence public.brocard_transactions_id_seq    to service_role, postgres;
```

- [ ] **Step 2: Применить миграцию**

```bash
cd app && npm run db:migrate
```

Ожидается: лог применения без ошибок, в конце `[db] migrations applied`.

- [ ] **Step 3: Проверить, что таблицы и констрейнт на месте**

```bash
psql "$SUPABASE_DB_URL" -c "\dt public.expense_*" -c "\d public.manual_expenses" -c "select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'external_sync_runs_source_check';"
```

Ожидается: три таблицы `expense_*`, таблица `manual_expenses` с `check (amount > 0)`, и в определении констрейнта присутствуют `'brocard'`, `'fx_cbr'`, `'expense_rules'`.

- [ ] **Step 4: Коммит**

```bash
git add supabase/migrations/20260730_0001_expenses_core.sql
git commit -m "feat(expenses): таблицы разметки, сырьё Brocard и ручных трат, курсы ЦБ"
```

---

### Task 2: Миграция — витрина `expenses_v`

**Files:**
- Create: `supabase/migrations/20260730_0002_expenses_view.sql`

- [ ] **Step 1: Написать миграцию**

Создать файл `supabase/migrations/20260730_0002_expenses_view.sql`:

```sql
-- Витрина расходов: четыре источника + разметка + курс валюты.
--
-- Присоединения внешние: неразмеченная трата обязана быть видна как «без
-- категории», а не тихо исчезнуть из суммы. Строка без курса видна там же и
-- по той же причине — с amount_rub = NULL.

create or replace view public.expenses_v as
with raw as (
  select
    bt.bank            as source,
    bt.transaction_id  as source_ref,
    bt.occurred_at     as occurred_at,
    bt.amount          as amount,
    bt.currency        as currency,
    bt.payee_name      as counterparty,
    bt.payee_inn       as counterparty_inn,
    bt.purpose         as details
  from public.bank_transactions bt
  where bt.direction = 'debit'

  union all

  select
    'brocard',
    b.external_id,
    b.occurred_at,
    b.amount,
    b.currency,
    b.merchant,
    null::text,
    b.merchant_category
  from public.brocard_transactions b

  union all

  select
    'manual',
    m.id::text,
    (m.occurred_on::timestamp at time zone 'Europe/Moscow'),
    m.amount,
    m.currency,
    m.payer,
    null::text,
    m.comment
  from public.manual_expenses m
)
select
  r.source,
  r.source_ref,
  r.occurred_at,
  (r.occurred_at at time zone 'Europe/Moscow')::date as occurred_on_msk,
  r.amount,
  r.currency,
  r.counterparty,
  r.counterparty_inn,
  r.details,
  c.vendor_id,
  c.method as classification_method,
  v.name   as vendor_name,
  v.category,
  case
    when r.currency = 'RUB' then r.amount
    else r.amount * fx.rate
  end as amount_rub
from raw r
left join public.expense_classifications c
       on c.source = r.source
      and c.source_ref = r.source_ref
left join public.expense_vendors v
       on v.id = c.vendor_id
left join lateral (
  -- Ближайший курс НЕ ПОЗЖЕ даты операции: ЦБ не публикует курс в выходные
  -- и праздники, поэтому join по равенству дат оставил бы такие траты без
  -- рублёвой суммы.
  select f.rate
  from public.fx_rates f
  where f.currency = r.currency
    and f.rate_date <= (r.occurred_at at time zone 'Europe/Moscow')::date
  order by f.rate_date desc
  limit 1
) fx on true;

alter view public.expenses_v set (security_invoker = on);

grant select on public.expenses_v to service_role, postgres;

comment on view public.expenses_v is
  'Строка = трата. Источники: дебет bank_transactions (tochka/tbank), brocard_transactions, manual_expenses. category=transfer — перемещение, потребитель обязан исключать его из итога.';
```

- [ ] **Step 2: Применить и проверить, что приход не просочился**

```bash
cd app && npm run db:migrate
psql "$SUPABASE_DB_URL" -c "select source, count(*) from public.expenses_v group by source order by 1;"
psql "$SUPABASE_DB_URL" -c "select count(*) as credit_leaked from public.expenses_v e join public.bank_transactions b on b.transaction_id = e.source_ref and b.bank = e.source where b.direction = 'credit';"
```

Ожидается: `credit_leaked = 0`. Число строк по источникам на этом шаге может быть нулевым — дебет ещё не залит, это нормально.

- [ ] **Step 3: Коммит**

```bash
git add supabase/migrations/20260730_0002_expenses_view.sql
git commit -m "feat(expenses): витрина expenses_v"
```

---

### Task 3: Миграция — функция `apply_expense_rules`

**Files:**
- Create: `supabase/migrations/20260730_0003_apply_expense_rules.sql`

Логика применения правил живёт в SQL, а не в Python, потому что её зовут двое: ночной синк и API после ручной разметки с созданием правила. Одна реализация вместо двух расходящихся.

- [ ] **Step 1: Написать миграцию**

Создать файл `supabase/migrations/20260730_0003_apply_expense_rules.sql`:

```sql
-- Применение правил разметки к неразмеченным тратам.
--
-- p_rule_id = NULL → прогнать все правила (ночной синк).
-- p_rule_id = <id> → прогнать одно только что созданное правило (вызов из API
-- после ручной разметки с галкой «применить ко всем похожим»).
--
-- Возвращает число затронутых строк.

create or replace function public.apply_expense_rules(p_rule_id uuid default null)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with matched as (
    select distinct on (e.source, e.source_ref)
           e.source,
           e.source_ref,
           r.vendor_id,
           r.id as rule_id
    from public.expenses_v e
    join public.expense_rules r
      on (p_rule_id is null or r.id = p_rule_id)
     and (r.source is null or r.source = e.source)
    cross join lateral (
      select case r.match_field
               when 'payee_inn' then e.counterparty_inn
               when 'purpose'   then e.details
               -- payee_name и merchant — одно и то же поле витрины:
               -- у банка это получатель платежа, у Brocard это мерчант.
               else e.counterparty
             end as field_value
    ) f
    where f.field_value is not null
      and (
        (r.match_type = 'exact'
          and lower(btrim(f.field_value)) = lower(btrim(r.pattern)))
        or
        -- position(), а не LIKE: образец приходит от человека и может
        -- содержать % или _, которые LIKE трактует как шаблон.
        (r.match_type = 'contains'
          and position(lower(btrim(r.pattern)) in lower(f.field_value)) > 0)
      )
    order by e.source, e.source_ref, r.priority, r.created_at
  )
  insert into public.expense_classifications (source, source_ref, vendor_id, method, rule_id)
  select m.source, m.source_ref, m.vendor_id, 'rule', m.rule_id
  from matched m
  on conflict (source, source_ref) do update
     set vendor_id     = excluded.vendor_id,
         rule_id       = excluded.rule_id,
         classified_at = now()
   -- Ключевая строка всей задачи: правило не трогает то, что размечено
   -- человеком. Защита структурная, а не договорённость между разработчиками.
   where public.expense_classifications.method = 'rule';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.apply_expense_rules(uuid) from public;
grant execute on function public.apply_expense_rules(uuid) to service_role, postgres;

comment on function public.apply_expense_rules(uuid) is
  'Размечает траты по expense_rules. Строки с method=manual не перезаписываются никогда.';
```

- [ ] **Step 2: Применить миграцию**

```bash
cd app && npm run db:migrate
```

- [ ] **Step 3: Проверить защиту ручной разметки на живых данных**

```bash
psql "$SUPABASE_DB_URL" <<'SQL'
begin;
insert into public.expense_vendors (name, category) values ('__t_auto', 'tools'), ('__t_manual', 'tools');
insert into public.manual_expenses (occurred_on, amount, currency, payer, comment, created_by)
select current_date, 100, 'RUB', '__t_payer', 'проверка', id from public.profiles limit 1
returning id \gset
insert into public.expense_classifications (source, source_ref, vendor_id, method)
values ('manual', :'id', (select id from public.expense_vendors where name = '__t_manual'), 'manual');
insert into public.expense_rules (vendor_id, match_field, match_type, pattern, source)
values ((select id from public.expense_vendors where name = '__t_auto'), 'payee_name', 'contains', '__t_payer', 'manual');
select public.apply_expense_rules() as applied;
select v.name as should_stay_manual
from public.expense_classifications c
join public.expense_vendors v on v.id = c.vendor_id
where c.source = 'manual' and c.source_ref = :'id';
rollback;
SQL
```

Ожидается: `should_stay_manual = __t_manual`. Если вернулось `__t_auto` — условие `where … method = 'rule'` потеряно, и правило стёрло ручную работу.

- [ ] **Step 4: Проверить выбор правила: приоритет, регистр, contains и ограничение по источнику**

```bash
psql "$SUPABASE_DB_URL" <<'SQL'
begin;
insert into public.expense_vendors (name, category)
values ('__t_low', 'tools'), ('__t_high', 'tools'), ('__t_wrong_source', 'tools');

insert into public.manual_expenses (occurred_on, amount, currency, payer, created_by)
select current_date, 100, 'RUB', 'ООО РОМАШКА ПЛЮС', id from public.profiles limit 1
returning id \gset

-- Три конкурирующих правила на одну операцию.
insert into public.expense_rules (vendor_id, match_field, match_type, pattern, source, priority) values
  ((select id from public.expense_vendors where name = '__t_high'),         'payee_name', 'contains', 'ромашка', null,     10),
  ((select id from public.expense_vendors where name = '__t_low'),          'payee_name', 'contains', 'плюс',    null,    900),
  ((select id from public.expense_vendors where name = '__t_wrong_source'), 'payee_name', 'contains', 'ромашка', 'tochka',  1);

select public.apply_expense_rules() as applied;

select v.name as winner
from public.expense_classifications c
join public.expense_vendors v on v.id = c.vendor_id
where c.source = 'manual' and c.source_ref = :'id';
rollback;
SQL
```

Ожидается: `winner = __t_high`. Это проверяет сразу три вещи — образец в нижнем регистре совпал с текстом в верхнем, из двух подошедших правил выиграло с меньшим `priority`, а правило с `source='tochka'` к ручной трате не применилось, хотя приоритет у него самый высокий.

- [ ] **Step 5: Коммит**

```bash
git add supabase/migrations/20260730_0003_apply_expense_rules.sql
git commit -m "feat(expenses): функция apply_expense_rules с защитой ручной разметки"
```

---

### Task 4: Тестовая инфраструктура сервиса синка

**Files:**
- Create: `services/portal-external-sync/pytest.ini`
- Create: `services/portal-external-sync/requirements-dev.txt`
- Create: `services/portal-external-sync/tests/__init__.py`

Тестов у сервиса пока нет; берём схему соседнего `services/instantly-sync-bot`.

- [ ] **Step 1: Создать конфиг pytest**

`services/portal-external-sync/pytest.ini`:

```ini
[pytest]
asyncio_mode = auto
testpaths = tests
```

- [ ] **Step 2: Создать requirements-dev.txt**

`services/portal-external-sync/requirements-dev.txt`:

```
-r requirements.txt
pytest==8.2.0
pytest-asyncio==0.23.7
respx==0.21.1
```

- [ ] **Step 3: Создать пустой пакет тестов**

`services/portal-external-sync/tests/__init__.py` — пустой файл.

- [ ] **Step 4: Установить и убедиться, что pytest стартует**

```bash
cd services/portal-external-sync && pip install -r requirements-dev.txt && python -m pytest
```

Ожидается: `no tests ran` — тестов ещё нет, но раннер поднимается и импорты сервиса не падают.

- [ ] **Step 5: Коммит**

```bash
git add services/portal-external-sync/pytest.ini services/portal-external-sync/requirements-dev.txt services/portal-external-sync/tests/__init__.py
git commit -m "chore(sync): pytest для portal-external-sync"
```

---

### Task 5: Общий контракт строки `bank_transactions`

**Files:**
- Modify: `services/portal-external-sync/sources/_bank_common.py`

Точка и Т-Банк собирают одинаковый кортеж из 16 полей в двух местах. Перед тем как добавлять туда дебет, порядок колонок выносится в одну константу — иначе тесты придётся писать на позиционные индексы, а расхождение порядка между двумя источниками не заметит никто.

- [ ] **Step 1: Дописать в конец `_bank_common.py`**

```python
#: Порядок колонок в INSERT'ах обоих банковских источников.
#: Менять только вместе с обоими _upsert().
BANK_COLUMNS: tuple[str, ...] = (
    "bank", "account_id", "transaction_id", "document_number",
    "occurred_at", "amount", "currency", "direction",
    "payer_name", "payer_inn", "payee_name", "payee_inn",
    "purpose", "is_revenue", "exclude_reason", "raw",
)


def to_row(d: dict) -> tuple:
    """dict → кортеж в порядке BANK_COLUMNS для executemany."""
    return tuple(d[c] for c in BANK_COLUMNS)
```

- [ ] **Step 2: Проверить импорт**

```bash
cd services/portal-external-sync && python -c "from sources._bank_common import BANK_COLUMNS, to_row; print(len(BANK_COLUMNS))"
```

Ожидается: `16`

- [ ] **Step 3: Коммит**

```bash
git add services/portal-external-sync/sources/_bank_common.py
git commit -m "refactor(sync): единый порядок колонок bank_transactions"
```

---

### Task 6: Точка — дебет

**Files:**
- Modify: `services/portal-external-sync/sources/bank_tochka.py`
- Test: `services/portal-external-sync/tests/test_bank_mapping.py`

- [ ] **Step 1: Написать падающий тест**

Создать `services/portal-external-sync/tests/test_bank_mapping.py`:

```python
"""Маппинг операций Точки в строку bank_transactions.

Логика вынесена в чистую функцию map_transaction именно ради этих тестов:
сам _fetch_period ходит в сеть и в юните непроверяем.
"""
from sources.bank_tochka import map_transaction

CREDIT = {
    "creditDebitIndicator": "Credit",
    "transactionId": "tx-credit-1",
    "documentNumber": "101",
    "documentProcessDate": "2026-07-15",
    "Amount": {"amount": "5000.00"},
    "DebtorParty": {"name": "ООО Клиент", "inn": "7701234567"},
    "CreditorParty": {"name": "ИП Мы", "inn": "165808519703"},
    "description": "Оплата по счёту 42",
}

DEBIT = {
    "creditDebitIndicator": "Debit",
    "transactionId": "tx-debit-1",
    "documentNumber": "202",
    "documentProcessDate": "2026-07-16",
    "Amount": {"amount": "1500.50"},
    "DebtorParty": {"name": "ИП Мы", "inn": "165808519703"},
    "CreditorParty": {"name": "ООО ЯНДЕКС", "inn": "7736207543"},
    "description": "Оплата рекламных услуг",
}


def test_credit_keeps_payer_and_revenue_flag():
    row = map_transaction(CREDIT, "acc-1")
    assert row["direction"] == "credit"
    assert row["payer_name"] == "ООО Клиент"
    assert row["payer_inn"] == "7701234567"
    assert row["payee_name"] is None
    assert row["is_revenue"] is True
    assert row["exclude_reason"] is None


def test_debit_fills_payee_and_leaves_revenue_unset():
    row = map_transaction(DEBIT, "acc-1")
    assert row["direction"] == "debit"
    assert row["payee_name"] == "ООО ЯНДЕКС"
    assert row["payee_inn"] == "7736207543"
    assert row["payer_name"] is None
    # Классификатор выручки к расходу неприменим: пустой is_revenue честнее,
    # чем False, который читался бы как «проверили и это не выручка».
    assert row["is_revenue"] is None
    assert row["exclude_reason"] is None


def test_unknown_indicator_is_skipped():
    assert map_transaction({"creditDebitIndicator": "Reserved"}, "acc-1") is None


def test_transaction_id_falls_back_to_document_number():
    tx = dict(DEBIT)
    del tx["transactionId"]
    row = map_transaction(tx, "acc-9")
    assert row["transaction_id"] == "acc-9|202"
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
cd services/portal-external-sync && python -m pytest tests/test_bank_mapping.py -v
```

Ожидается: FAIL — `ImportError: cannot import name 'map_transaction'`.

- [ ] **Step 3: Реализовать `map_transaction` и переключить `_fetch_period`**

В `services/portal-external-sync/sources/bank_tochka.py` заменить импорт:

```python
from ._bank_common import classify_revenue, parse_date, to_row
```

Добавить функцию модульного уровня (после констант, до класса):

```python
def map_transaction(t: dict, acc: str) -> dict | None:
    """Операция Точки → словарь полей bank_transactions. None — пропустить.

    Классификатор «выручка / не выручка» осмыслен только для прихода: у
    расхода нет плательщика-клиента, и прогонять по нему classify_revenue
    значит записывать в exclude_reason случайный мусор.
    """
    indicator = t.get("creditDebitIndicator")
    if indicator not in ("Credit", "Debit"):
        return None
    is_credit = indicator == "Credit"

    debtor = t.get("DebtorParty") or {}
    creditor = t.get("CreditorParty") or {}
    purpose = t.get("description", "") or ""

    payer = (debtor.get("name") or "") if is_credit else ""
    payer_inn = (debtor.get("inn") or "") if is_credit else ""
    payee = "" if is_credit else (creditor.get("name") or "")
    payee_inn = "" if is_credit else (creditor.get("inn") or "")

    exclude_reason = classify_revenue(payer, payer_inn, purpose) if is_credit else ""
    is_revenue = (not exclude_reason) if is_credit else None

    doc = t.get("documentNumber")
    tx_id = t.get("transactionId") or f"{acc}|{doc}"

    return {
        "bank": "tochka",
        "account_id": acc,
        "transaction_id": str(tx_id),
        "document_number": str(doc) if doc is not None else None,
        "occurred_at": parse_date(t.get("documentProcessDate", "")),
        "amount": float((t.get("Amount") or {}).get("amount", 0)),
        "currency": "RUB",
        "direction": "credit" if is_credit else "debit",
        "payer_name": payer or None,
        "payer_inn": payer_inn or None,
        "payee_name": payee or None,
        "payee_inn": payee_inn or None,
        "purpose": purpose or None,
        "is_revenue": is_revenue,
        "exclude_reason": exclude_reason or None,
        "raw": json.dumps(t, ensure_ascii=False),
    }
```

Заменить тело цикла в `_fetch_period` (сейчас `bank_tochka.py:92-122`) на:

```python
        rows: list[tuple] = []
        for t in stmt.get("Transaction", []) or []:
            mapped = map_transaction(t, acc)
            if mapped is not None:
                rows.append(to_row(mapped))
        return rows
```

В `_upsert` дополнить `DO UPDATE SET`, чтобы повторный прогон чинил ранее сохранённые строки:

```python
               ON CONFLICT (bank, transaction_id) DO UPDATE SET
                 direction      = EXCLUDED.direction,
                 payee_name     = EXCLUDED.payee_name,
                 payee_inn      = EXCLUDED.payee_inn,
                 is_revenue     = EXCLUDED.is_revenue,
                 exclude_reason = EXCLUDED.exclude_reason,
                 raw            = EXCLUDED.raw,
                 synced_at      = now()""",
```

Обновить docstring модуля: вместо «Тянет входящие транзакции (только creditDebitIndicator='Credit')» — «Тянет приход и расход: Credit → выручка (с классификатором), Debit → расход».

- [ ] **Step 4: Запустить тесты**

```bash
cd services/portal-external-sync && python -m pytest tests/test_bank_mapping.py -v
```

Ожидается: 4 passed.

- [ ] **Step 5: Коммит**

```bash
git add services/portal-external-sync/sources/bank_tochka.py services/portal-external-sync/tests/test_bank_mapping.py
git commit -m "feat(sync): Точка отдаёт расход наравне с приходом"
```

---

### Task 7: Т-Банк — дебет

**Files:**
- Modify: `services/portal-external-sync/sources/bank_tbank.py`
- Test: `services/portal-external-sync/tests/test_bank_mapping.py`

Сейчас источник отбрасывает всё, где `recipientAccount != ACCOUNT` — то есть ровно исходящие.

- [ ] **Step 1: Дописать падающие тесты**

Добавить в конец `services/portal-external-sync/tests/test_bank_mapping.py`:

```python
from sources.bank_tbank import map_operation

ACC = "40802810600001780269"

TB_CREDIT = {
    "operationId": "op-1",
    "id": 11,
    "date": "2026-07-15",
    "amount": 5000,
    "recipientAccount": ACC,
    "payerName": "ООО Клиент",
    "payerInn": "7701234567",
    "paymentPurpose": "Оплата по счёту 42",
}

TB_DEBIT = {
    "operationId": "op-2",
    "id": 12,
    "date": "2026-07-16",
    "amount": 1500.5,
    "recipientAccount": "40702810000000000001",
    "payerAccount": ACC,
    # Живая проверка API 2026-07-30: имя получателя приходит в "recipient",
    # такого поля, как "recipientName", в ответе нет.
    "recipient": "ООО ЯНДЕКС",
    "recipientInn": "7736207543",
    "paymentPurpose": "Оплата рекламных услуг",
}


def test_tbank_credit_marks_revenue():
    row = map_operation(TB_CREDIT, ACC)
    assert row["direction"] == "credit"
    assert row["payer_name"] == "ООО Клиент"
    assert row["is_revenue"] is True


def test_tbank_debit_fills_payee():
    row = map_operation(TB_DEBIT, ACC)
    assert row["direction"] == "debit"
    assert row["payee_name"] == "ООО ЯНДЕКС"
    assert row["payee_inn"] == "7736207543"
    assert row["is_revenue"] is None


def test_tbank_foreign_operation_is_skipped():
    """Операция, где наш счёт не участвует ни одной стороной."""
    assert map_operation({"recipientAccount": "1", "payerAccount": "2"}, ACC) is None
```

- [ ] **Step 2: Запустить и убедиться, что падает**

```bash
cd services/portal-external-sync && python -m pytest tests/test_bank_mapping.py -v
```

Ожидается: FAIL — `ImportError: cannot import name 'map_operation'`.

- [ ] **Step 3: Реализовать**

В `services/portal-external-sync/sources/bank_tbank.py` заменить импорт:

```python
from ._bank_common import classify_revenue, parse_date, to_row
```

Добавить функцию модульного уровня перед классом:

```python
def map_operation(o: dict, account: str) -> dict | None:
    """Операция Т-Банка → словарь полей bank_transactions. None — пропустить.

    Направление определяем по тому, какой стороной стоит наш счёт. Операция,
    где его нет вообще, к нам не относится.
    """
    is_credit = o.get("recipientAccount") == account
    is_debit = o.get("payerAccount") == account
    if not is_credit and not is_debit:
        return None

    purpose = o.get("paymentPurpose", "") or ""
    payer = (o.get("payerName") or "") if is_credit else ""
    payer_inn = (o.get("payerInn") or "") if is_credit else ""
    payee = "" if is_credit else (o.get("recipient") or "")
    payee_inn = "" if is_credit else (o.get("recipientInn") or "")

    exclude_reason = classify_revenue(payer, payer_inn, purpose) if is_credit else ""
    is_revenue = (not exclude_reason) if is_credit else None

    tx_id = o.get("operationId") or f"{account}|{o.get('id')}"

    return {
        "bank": "tbank",
        "account_id": account,
        "transaction_id": str(tx_id),
        "document_number": str(o.get("id")) if o.get("id") is not None else None,
        "occurred_at": parse_date(o.get("date", "")),
        "amount": float(o.get("amount", 0)),
        "currency": "RUB",
        "direction": "credit" if is_credit else "debit",
        "payer_name": payer or None,
        "payer_inn": payer_inn or None,
        "payee_name": payee or None,
        "payee_inn": payee_inn or None,
        "purpose": purpose or None,
        "is_revenue": is_revenue,
        "exclude_reason": exclude_reason or None,
        "raw": json.dumps(o, ensure_ascii=False),
    }
```

Заменить тело цикла в `run` (сейчас `bank_tbank.py:55-80`) на:

```python
                rows: list[tuple] = []
                for o in data.get("operation", []) or []:
                    mapped = map_operation(o, ACCOUNT)
                    if mapped is not None:
                        rows.append(to_row(mapped))
```

В `_upsert` дополнить `DO UPDATE SET` теми же полями, что в Task 6 Step 3:

```python
               ON CONFLICT (bank, transaction_id) DO UPDATE SET
                 direction      = EXCLUDED.direction,
                 payee_name     = EXCLUDED.payee_name,
                 payee_inn      = EXCLUDED.payee_inn,
                 is_revenue     = EXCLUDED.is_revenue,
                 exclude_reason = EXCLUDED.exclude_reason,
                 raw            = EXCLUDED.raw,
                 synced_at      = now()""",
```

Обновить docstring модуля: «Тянет входящие операции» → «Тянет операции по нашему счёту в обе стороны».

- [ ] **Step 4: Запустить тесты**

```bash
cd services/portal-external-sync && python -m pytest tests/test_bank_mapping.py -v
```

Ожидается: 7 passed.

- [ ] **Step 5: Коммит**

```bash
git add services/portal-external-sync/sources/bank_tbank.py services/portal-external-sync/tests/test_bank_mapping.py
git commit -m "feat(sync): Т-Банк отдаёт расход наравне с приходом"
```

---

### Task 8: Курсы ЦБ

**Files:**
- Create: `services/portal-external-sync/sources/fx_cbr.py`
- Test: `services/portal-external-sync/tests/test_fx_cbr.py`

- [ ] **Step 1: Написать падающий тест**

Создать `services/portal-external-sync/tests/test_fx_cbr.py`:

```python
"""Парсер XML ЦБ.

Два подвоха, ради которых тест и существует:
  - Value приходит с запятой как десятичным разделителем;
  - Nominal у части валют не 1 (у юаня 10), и без деления курс завышен в 10 раз.
"""
from datetime import date
from decimal import Decimal

from sources.fx_cbr import parse_cbr_xml

SAMPLE = """<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="30.07.2026" name="Foreign Currency Market">
<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>78,4512</Value></Valute>
<Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Name>Евро</Name><Value>91,2033</Value></Valute>
<Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>10</Nominal><Name>Китайских юаней</Name><Value>108,5000</Value></Valute>
</ValCurs>"""


def test_reads_published_date_not_requested_one():
    published_on, _ = parse_cbr_xml(SAMPLE)
    assert published_on == date(2026, 7, 30)


def test_comma_decimal_separator():
    _, rates = parse_cbr_xml(SAMPLE)
    assert rates["USD"] == Decimal("78.4512")


def test_divides_by_nominal():
    _, rates = parse_cbr_xml(SAMPLE)
    assert rates["CNY"] == Decimal("10.85")
```

- [ ] **Step 2: Запустить и убедиться, что падает**

```bash
cd services/portal-external-sync && python -m pytest tests/test_fx_cbr.py -v
```

Ожидается: FAIL — `ModuleNotFoundError: No module named 'sources.fx_cbr'`.

- [ ] **Step 3: Реализовать источник**

Создать `services/portal-external-sync/sources/fx_cbr.py`:

```python
"""Курсы ЦБ → fx_rates.

Спрашиваем курс только за те даты, где реально есть траты в валюте и курса
ещё нет. Дата запроса и дата публикации — разные вещи: в выходные ЦБ отдаёт
последний рабочий курс, и атрибут Date в ответе указывает на него. Пишем
строку под датой публикации, а витрина берёт ближайший курс не позже даты
операции — так выходные закрываются сами.

Источники валютных дат — только brocard_transactions и manual_expenses.
bank_tochka и bank_tbank сюда не входят: оба банковских источника жёстко
пишут currency='RUB' (см. map_transaction/map_operation), валютных трат в
bank_transactions не бывает в принципе.

Непригодный ответ за одну дату (сеть, HTTP-ошибка, тело не парсится) не
должен ронять остальные даты прогона — та же изоляция «единица работы =
одна дата», что у банковских источников.
"""
from __future__ import annotations

import traceback
import xml.etree.ElementTree as ET
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

import asyncpg
import httpx

from .base import SyncSource

API_URL = "https://www.cbr.ru/scripts/XML_daily.asp"

#: Потолок на прогон, чтобы первый бэкфилл не превратился в тысячу запросов
#: за одну ночь. Если недостающих дат больше — часть достаётся следующим
#: прогонам, run() об этом печатает (см. ниже), а не молчит про хвост.
MAX_DATES_PER_RUN = 120

#: Окно "курс не устарел" для предиката отбора дат — см. комментарий у SQL
#: ниже про то, почему это окно, а не точное совпадение дат и не "хоть один
#: более ранний курс существует".
_STALE_WINDOW_SQL = "interval '10 days'"

_NEEDED_DATES_SQL = f"""
    SELECT DISTINCT d
    FROM (
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
      FROM brocard_transactions
      UNION ALL
      SELECT occurred_on AS d, currency
      FROM manual_expenses
    ) x
    WHERE x.currency <> 'RUB'
      AND NOT EXISTS (
        -- Окно в 10 дней, а НЕ:
        --   (а) точное совпадение дат — ЦБ не публикует курс в выходные и
        --       праздники, и мы намеренно пишем строку под пятницей вместо
        --       субботы, поэтому rate_date = x.d для субботы никогда не
        --       будет true, и источник ходил бы в ЦБ за одной и той же
        --       субботой каждую ночь вечно;
        --   (б) "существует хоть один курс этой валюты с rate_date <= x.d"
        --       без нижней границы — это и есть баг, который тут был:
        --       после первой же загрузки валюты в fx_rates появляется одна
        --       строка, и она <= любой более поздней дате, поэтому ВСЕ
        --       будущие даты этой валюты считаются закрытыми навсегда —
        --       источник перестаёт ходить в ЦБ за свежим курсом, а витрина
        --       (join "ближайший курс не позже") тихо продолжает считать
        --       по этой годовалой строке. Дашборд выглядит полным (нет
        --       NULL, нет ошибок), а деньги в нём молча неверные.
        -- Правильное условие — "ближайший доступный курс для этой даты не
        -- устарел", то есть окно: rate_date <= x.d И rate_date не более чем
        -- на N дней раньше x.d. 10 дней выбрано по самому длинному реальному
        -- разрыву в публикации ЦБ — новогодним каникулам (8 дней), с
        -- запасом. Ошибка в сторону лишнего запроса к ЦБ безвредна —
        -- ON CONFLICT DO UPDATE делает повтор идемпотентным; ошибка в
        -- другую сторону (шире окно/без окна) даёт молча неверные суммы.
        -- Не сужать и не убирать нижнюю границу.
        SELECT 1 FROM fx_rates f
        WHERE f.currency = x.currency
          AND f.rate_date <= x.d
          AND f.rate_date >= x.d - {_STALE_WINDOW_SQL}
      )
    ORDER BY d
"""

# Тот же предикат, что и выше, но ограниченный конкретными датами: зовётся
# после того, как для dates_to_process уже сходили в ЦБ, чтобы понять, какие
# валюты так и остались без курса — сигнал "у ЦБ такой валюты вообще нет",
# а не "ещё не успели дойти".
_STILL_MISSING_CURRENCIES_SQL = f"""
    SELECT DISTINCT x.currency
    FROM (
      SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS d, currency
      FROM brocard_transactions
      UNION ALL
      SELECT occurred_on AS d, currency
      FROM manual_expenses
    ) x
    WHERE x.currency <> 'RUB'
      AND x.d = ANY($1::date[])
      AND NOT EXISTS (
        SELECT 1 FROM fx_rates f
        WHERE f.currency = x.currency
          AND f.rate_date <= x.d
          AND f.rate_date >= x.d - {_STALE_WINDOW_SQL}
      )
"""


def parse_cbr_xml(text: str) -> tuple[date, dict[str, Decimal]]:
    """XML ЦБ → (дата публикации, {код валюты: рублей за единицу}).

    Value приходит с запятой как десятичным разделителем, а не с точкой.
    Nominal у части валют не 1 (у юаня — 10): без деления на него курс
    завышен ровно в Nominal раз. Запись без CharCode (не под каким ключом
    класть в fx_rates) или без Value (нечего делить) — пропускается, а не
    роняет разбор всего ответа.
    """
    root = ET.fromstring(text)
    published_on = datetime.strptime(root.attrib["Date"], "%d.%m.%Y").date()

    rates: dict[str, Decimal] = {}
    for valute in root.findall("Valute"):
        code = (valute.findtext("CharCode") or "").strip()
        value = (valute.findtext("Value") or "").strip().replace(",", ".")
        nominal = (valute.findtext("Nominal") or "1").strip().replace(",", ".")
        if not code or not value:
            continue
        try:
            rates[code] = Decimal(value) / Decimal(nominal)
        except (InvalidOperation, ZeroDivisionError):
            continue
    return published_on, rates


class FxCbrSync(SyncSource):
    name = "fx_cbr"

    async def run(self, conn: asyncpg.Connection) -> int:
        needed = await conn.fetch(_NEEDED_DATES_SQL)
        if not needed:
            return 0

        all_dates: list[date] = sorted(row["d"] for row in needed)
        total_dates_needed = len(all_dates)
        dates_to_process = all_dates[:MAX_DATES_PER_RUN]

        if total_dates_needed > MAX_DATES_PER_RUN:
            remaining = total_dates_needed - MAX_DATES_PER_RUN
            print(
                f"[fx_cbr] лимит {MAX_DATES_PER_RUN} дат за прогон достигнут: "
                f"обработано {MAX_DATES_PER_RUN} из {total_dates_needed}, "
                f"ещё {remaining} дата(ы) — в следующих прогонах",
                flush=True,
            )

        total = 0
        skip_counts: dict[str, int] = {}

        async with httpx.AsyncClient(timeout=30) as client:
            for d in dates_to_process:
                # Изоляция даты: сбой одного ответа ЦБ (сеть, HTTP-ошибка,
                # неразбираемое тело) не должен обрывать остальные даты
                # прогона — источник обязан дойти до конца и залить то, что
                # удалось разобрать.
                try:
                    resp = await client.get(API_URL, params={"date_req": d.strftime("%d/%m/%Y")})
                    if resp.status_code >= 400:
                        print(
                            f"[fx_cbr] skip date_req={d.isoformat()}: HTTP {resp.status_code}",
                            flush=True,
                        )
                        skip_counts["http_error"] = skip_counts.get("http_error", 0) + 1
                        continue

                    try:
                        published_on, rates = parse_cbr_xml(resp.text)
                    except (ET.ParseError, KeyError, ValueError) as e:
                        # Тело пришло, но не разобралось: битый XML, либо в
                        # корне нет ожидаемого атрибута Date.
                        print(
                            f"[fx_cbr] skip date_req={d.isoformat()}: тело не разобралось — {e}",
                            flush=True,
                        )
                        skip_counts["unparsable"] = skip_counts.get("unparsable", 0) + 1
                        continue

                    if not rates:
                        print(
                            f"[fx_cbr] skip date_req={d.isoformat()}: ни одной валюты в ответе",
                            flush=True,
                        )
                        skip_counts["empty"] = skip_counts.get("empty", 0) + 1
                        continue

                    await conn.executemany(
                        """INSERT INTO fx_rates (rate_date, currency, rate, source)
                           VALUES ($1, $2, $3, 'cbr')
                           ON CONFLICT (rate_date, currency) DO UPDATE
                             SET rate = EXCLUDED.rate, fetched_at = now()""",
                        [(published_on, code, rate) for code, rate in rates.items()],
                    )
                    total += len(rates)
                except Exception as e:
                    print(
                        f"[fx_cbr] date_req={d.isoformat()} FAIL: {e}\n{traceback.format_exc()}",
                        flush=True,
                    )
                    skip_counts["error"] = skip_counts.get("error", 0) + 1

        if skip_counts:
            total_skipped = sum(skip_counts.values())
            breakdown = ", ".join(
                f"{reason}={n}" for reason, n in sorted(skip_counts.items())
            )
            print(
                f"[fx_cbr] skipped {total_skipped} date(s): {breakdown}",
                flush=True,
            )

        # Валюта вне ежедневного списка ЦБ (или опечатка в currency у
        # источника трат) никогда не получит строку в fx_rates, и с окном
        # вместо "любой более ранний курс" источник будет молча стучаться в
        # ЦБ за ней каждую ночь без единого сигнала. Явно называем, что не
        # закрылось, даже после успешных запросов выше.
        still_missing = await conn.fetch(
            _STILL_MISSING_CURRENCIES_SQL, dates_to_process
        )
        if still_missing:
            currencies = sorted(row["currency"] for row in still_missing)
            print(
                f"[fx_cbr] ЦБ не публикует курс для: {', '.join(currencies)} — "
                f"fx_rates для них не появится сам по себе, эти валюты будут "
                f"запрашиваться каждый прогон, пока курс не заведут вручную",
                flush=True,
            )

        return total
```

- [ ] **Step 4: Запустить тесты**

```bash
cd services/portal-external-sync && python -m pytest tests/ -v
```

Ожидается: 10 passed.

- [ ] **Step 5: Коммит**

```bash
git add services/portal-external-sync/sources/fx_cbr.py services/portal-external-sync/tests/test_fx_cbr.py
git commit -m "feat(sync): курсы ЦБ в fx_rates"
```

---

### Task 9: Источники Brocard и применения правил

**Files:**
- Create: `services/portal-external-sync/sources/brocard.py`
- Create: `services/portal-external-sync/sources/expense_rules.py`

Ключей Brocard пока нет, поэтому адаптер — скелет, который честно поднимает `NotImplementedError`: `main.py:84` логирует такой прогон как `partial` и идёт дальше. Так проводка в `SOURCES` делается сейчас и не переделывается потом.

- [ ] **Step 1: Создать `sources/brocard.py`**

```python
"""Brocard (виртуальные карты) → brocard_transactions.

Доступы на момент написания не выданы. Пока нет BROCARD_API_KEY, источник
поднимает NotImplementedError — main.py залогирует прогон как 'partial' и
продолжит остальные источники.

Когда ключи появятся: заполнить API_BASE и _fetch(), маппинг класть в те же
колонки brocard_transactions (см. миграцию 20260730_0001).
"""
from __future__ import annotations

import os

import asyncpg

from .base import SyncSource

API_KEY = os.environ.get("BROCARD_API_KEY", "").strip()


class BrocardSync(SyncSource):
    name = "brocard"

    async def run(self, conn: asyncpg.Connection) -> int:
        if not API_KEY:
            raise NotImplementedError("BROCARD_API_KEY не задан")
        raise NotImplementedError("Brocard: адаптер не реализован — нет доступов к API")
```

- [ ] **Step 2: Создать `sources/expense_rules.py`**

```python
"""Применение правил разметки расходов.

Вся логика в SQL-функции apply_expense_rules(): её же зовёт API после ручной
разметки с созданием правила. Держать вторую реализацию на Python значило бы
получить два расходящихся ответа на один вопрос.

Идёт последним в SOURCES: размечать нужно то, что уже приехало этой ночью.
"""
from __future__ import annotations

import asyncpg

from .base import SyncSource


class ExpenseRulesSync(SyncSource):
    name = "expense_rules"

    async def run(self, conn: asyncpg.Connection) -> int:
        return int(await conn.fetchval("SELECT public.apply_expense_rules()"))
```

- [ ] **Step 3: Проверить, что модули импортируются**

```bash
cd services/portal-external-sync && python -c "from sources.brocard import BrocardSync; from sources.expense_rules import ExpenseRulesSync; print(BrocardSync.name, ExpenseRulesSync.name)"
```

Ожидается: `brocard expense_rules`

- [ ] **Step 4: Коммит**

```bash
git add services/portal-external-sync/sources/brocard.py services/portal-external-sync/sources/expense_rules.py
git commit -m "feat(sync): источники brocard и expense_rules"
```

---

### Task 10: Проводка источников в `main.py`

**Files:**
- Modify: `services/portal-external-sync/main.py:40-66`

- [ ] **Step 1: Добавить импорты**

После строки `from sources.bank_tbank import BankTBankSync` дописать:

```python
from sources.brocard import BrocardSync
from sources.fx_cbr import FxCbrSync
from sources.expense_rules import ExpenseRulesSync
```

- [ ] **Step 2: Расширить `SOURCES`**

Заменить список `SOURCES` (`main.py:60-66`) на:

```python
SOURCES = [
    MetrikaSync(),
    AmoSync(),
    AmoCompanyEnrichSync(),  # ходит на company_website и заполняет company_name; идёт СТРОГО после AmoSync
    BankTochkaSync(),
    BankTBankSync(),
    BrocardSync(),
    FxCbrSync(),        # после Brocard: спрашивает курсы под уже приехавшие валютные траты
    ExpenseRulesSync(), # строго последним: размечает всё, что приехало выше
]
```

- [ ] **Step 3: Обновить docstring модуля**

В шапке `main.py` заменить строку `Sources: Yandex Metrika, AMO CRM, Точка Банк, Т-Банк.` на:

```
Sources: Yandex Metrika, AMO CRM, Точка Банк, Т-Банк, Brocard, курсы ЦБ,
применение правил разметки расходов.
```

- [ ] **Step 4: Прогнать синк одним циклом и посмотреть лог прогонов**

```bash
cd services/portal-external-sync && python -c "import asyncio, main; asyncio.run(main.run_all())"
```

Ожидается в выводе: `[bank_tochka] ok — upserted N`, `[brocard] skipped — BROCARD_API_KEY не задан`, `[fx_cbr] ok`, `[expense_rules] ok`. Ни одного `FAIL`.

```bash
psql "$SUPABASE_DB_URL" -c "select source, status, records_upserted, error from external_sync_runs where started_at > now() - interval '1 hour' order by started_at;"
```

Ожидается: строки по всем источникам, у `brocard` статус `partial`, у остальных `success`. Ни одной строки со статусом `error`.

- [ ] **Step 5: Коммит**

```bash
git add services/portal-external-sync/main.py
git commit -m "feat(sync): проводка brocard, fx_cbr и expense_rules"
```

---

### Task 11: Вендоры перемещений

**Files:** нет — данные, заводятся SQL-запросом по факту содержимого выписки.

Без этого шага категория `transfer` пуста, а пополнения Brocard и возмещения подотчёта считаются расходом второй раз. Образцы правил нельзя выдумать заранее — их нужно взять из реальных назначений платежей.

- [ ] **Step 1: Найти кандидатов в выписке**

```bash
psql "$SUPABASE_DB_URL" -c "select counterparty, counterparty_inn, count(*) as ops, sum(amount_rub) as total from public.expenses_v where source in ('tochka','tbank') and vendor_id is null group by 1,2 order by total desc nulls last limit 30;"
```

Выписать из результата: получателя пополнений Brocard, получателя переводов на свой счёт в другом банке и строки возмещения CEO. У юрлиц предпочитать ИНН — он стабильнее названия.

- [ ] **Step 2: Завести вендоров и правила**

Подставить найденные значения вместо `<…>` и выполнить:

```bash
psql "$SUPABASE_DB_URL" <<'SQL'
insert into public.expense_vendors (name, category) values
  ('Пополнение Brocard',   'transfer'),
  ('Возмещение подотчёта', 'transfer'),
  ('Перевод между счетами','transfer')
on conflict do nothing;

insert into public.expense_rules (vendor_id, match_field, match_type, pattern) values
  ((select id from public.expense_vendors where name = 'Пополнение Brocard'),    'payee_inn',  'exact',    '<ИНН_получателя_Brocard>'),
  ((select id from public.expense_vendors where name = 'Возмещение подотчёта'),  'purpose',    'contains', '<кусок назначения возмещения>'),
  ((select id from public.expense_vendors where name = 'Перевод между счетами'), 'payee_inn',  'exact',    '<наш_ИНН>')
on conflict do nothing;

select public.apply_expense_rules() as applied;
SQL
```

- [ ] **Step 3: Проверить, что перемещения отделились**

```bash
psql "$SUPABASE_DB_URL" -c "select v.category, count(*) as ops, sum(e.amount_rub) as total from public.expenses_v e join public.expense_vendors v on v.id = e.vendor_id group by 1 order by 2 desc;"
```

Ожидается: строка `transfer` с ненулевой суммой. Если её нет — правила не совпали, вернуться к Step 1 и уточнить образцы.

- [ ] **Step 4: Зафиксировать образцы в спеке**

Дописать фактические ИНН и куски назначений в раздел «Двойной счёт» файла `docs/superpowers/specs/2026-07-30-expenses-dashboard-design.md`, чтобы через полгода было понятно, откуда взялись правила.

```bash
git add docs/superpowers/specs/2026-07-30-expenses-dashboard-design.md
git commit -m "docs(expenses): фактические правила перемещений"
```

---

### Task 12: Бэкфилл и приёмка

**Files:** нет — операционный шаг.

Периоды в обоих банковских источниках начинаются с 2023 года, и снятие фильтра тянет дебет за всю историю разом. Прогон тяжёлый, поэтому делается руками и один раз, а не в штатное ночное окно.

- [ ] **Step 1: Прогнать полный цикл ещё раз**

Первый прогон уже случился в Task 10 и подтянул дебет за все периоды с 2023 года. Этот повтор нужен, чтобы правила перемещений из Task 11 применились ко всей истории; все таблицы работают через UPSERT, поэтому повтор безопасен.

```bash
cd services/portal-external-sync && python -c "import asyncio, main; asyncio.run(main.run_all())" 2>&1 | tee /tmp/expenses-backfill.log
```

Ожидается: завершение без `FAIL`, в логе видно число upsert'нутых строк по каждому банку и ненулевой результат `expense_rules`.

- [ ] **Step 2: Сверить месяц с банковской выпиской**

```bash
psql "$SUPABASE_DB_URL" -c "select date_trunc('month', occurred_on_msk) as month, source, count(*) as ops, sum(amount_rub) as total_rub from public.expenses_v group by 1,2 order by 1 desc, 2 limit 20;"
```

Взять последний закрытый месяц и сверить сумму по `source='tochka'` с выпиской Точки за тот же месяц. Расхождение допустимо только на строках категории `transfer` — их из выписки вычесть отдельно.

- [ ] **Step 3: Проверить, что валютные траты получили курс**

```bash
psql "$SUPABASE_DB_URL" -c "select currency, count(*) as ops, count(amount_rub) as with_rate from public.expenses_v where currency <> 'RUB' group by 1;"
```

Ожидается: `with_rate = ops` для каждой валюты. Это же проверяет и выходные: ЦБ в субботу и воскресенье курс не публикует, и если бы витрина искала курс точным совпадением дат, траты этих дней остались бы без рублёвой суммы и попали в расхождение. Дырка означает либо пропуск в `fx_rates` (перезапустить `FxCbrSync`), либо потерянный `order by rate_date desc limit 1` в витрине.

- [ ] **Step 4: Зафиксировать результат приёмки**

Дописать в `wiki/log.md` строку с датой, числом залитых расходных операций и итогом сверки с выпиской.

```bash
git add wiki/log.md
git commit -m "chore(expenses): бэкфилл дебета и сверка с выпиской"
```

---

## Готовность

После этого плана расходы за любой период считаются одним запросом:

```sql
select v.category, v.name, count(*) as ops, sum(e.amount_rub) as total_rub
from public.expenses_v e
left join public.expense_vendors v on v.id = e.vendor_id
where e.occurred_on_msk >= date_trunc('month', current_date)
  and (v.category is distinct from 'transfer')
group by 1, 2
order by total_rub desc nulls last;
```

Дальше — `docs/superpowers/plans/2026-07-30-expenses-dashboard.md`: доступ к вкладке, API и сам дашборд.
