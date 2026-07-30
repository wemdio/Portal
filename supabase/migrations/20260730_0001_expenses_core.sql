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
