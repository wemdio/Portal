-- Ручной доход и привязка ручных записей к проекту и сделке AMO (26.10.2026).
--
-- Доходы раздела «Деньги» до этой миграции знали только то, что синкается
-- само: кредит банков и входящие переводы на криптокошелёк. Деньги из
-- источников, которые мы не синкаем (наличные, перевод на личную карту,
-- кошелёк, которого нет в синке), в доходе не появлялись вовсе — их вносят
-- руками кнопкой «+ Доход». Решение владельца: такая запись — это всегда
-- выручка, отдельной галочки «не выручка» у неё нет.
--
-- Ручной расход (manual_expenses) уже был; ему, как и доходу, добавлена
-- необязательная привязка к проекту портала и к сделке AMO.

-- ─── Ручной доход ────────────────────────────────────────────────────────

create table if not exists public.manual_incomes (
  id          uuid primary key default gen_random_uuid(),
  occurred_on date not null,
  amount      numeric(14,2) not null check (amount > 0),
  currency    text not null default 'RUB',
  -- Кто принёс деньги. Свободный текст, как manual_expenses.payer: витрина
  -- кладёт его в counterparty, и разбивка по плательщикам группирует по нему.
  payer       text not null,
  -- Способ получения («Наличные», «На карту»…). Хранится сразу подписью, а не
  -- ключом — тот же приём, что у manual_expenses.payer
  -- (20260801_0001_manual_expense_payer_label.sql): витрина отдаёт его в
  -- details как есть, расшифровывать ключ там было бы нечем. Список значений
  -- держит API (MANUAL_INCOME_CHANNELS в app/src/lib/expenses/types.ts).
  channel     text not null default 'Другое',
  -- За что деньги.
  comment     text,
  project_id  uuid references public.projects(id) on delete set null,
  -- Сделка AMO по amo_leads.amo_id. Без внешнего ключа: amo_leads — зеркало
  -- ночного синка, и сделка, удалённая в AMO, не должна ронять запись о
  -- деньгах. Тот же выбор, что у renewal_marks.amo_deal_id.
  amo_deal_id bigint,
  created_by  uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_manual_incomes_occurred_on
  on public.manual_incomes (occurred_on desc);
create index if not exists idx_manual_incomes_project
  on public.manual_incomes (project_id) where project_id is not null;
create index if not exists idx_manual_incomes_amo_deal
  on public.manual_incomes (amo_deal_id) where amo_deal_id is not null;

alter table public.manual_incomes enable row level security;

grant all on public.manual_incomes to service_role, postgres;

comment on table public.manual_incomes is
  'Доход из источников, которые не синкаются (наличные, личная карта и т.п.), внесённый руками кнопкой «+ Доход». Всегда выручка. В витрину incomes_v попадает с source=manual.';

-- ─── Уведомление «Поступила оплата» о ручном доходе ──────────────────────
-- Решение владельца: ручной доход идёт в ветку «Оплаты» так же, как банковский
-- платёж. Журнал повторяет crypto_income_notifications
-- (20261021_0011_crypto_income_notifications.sql), рассылает его тот же
-- services/portal-external-sync/bank_income.py. Своего baseline нет: истории
-- у таблицы нет, а записи до включения уведомлений отсекаются по
-- bank_income_notification_state.started_at.
--
-- on delete cascade: удалённая до отправки запись не должна уйти в чат.

create table if not exists public.manual_income_notifications (
  manual_income_id uuid primary key references public.manual_incomes(id) on delete cascade,
  chat_id bigint not null,
  thread_id integer not null check (thread_id > 0),
  status text not null default 'pending'
    check (status in ('pending','sending','sent','failed','unknown','skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  message_id bigint,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists manual_income_notifications_due_idx
  on public.manual_income_notifications(next_attempt_at) where status = 'pending';
alter table public.manual_income_notifications enable row level security;
revoke all on public.manual_income_notifications from anon, authenticated;
grant all on public.manual_income_notifications to service_role;

-- ─── Привязка ручного расхода ────────────────────────────────────────────

alter table public.manual_expenses
  add column if not exists project_id uuid references public.projects(id) on delete set null,
  add column if not exists amo_deal_id bigint;

create index if not exists idx_manual_expenses_project
  on public.manual_expenses (project_id) where project_id is not null;
create index if not exists idx_manual_expenses_amo_deal
  on public.manual_expenses (amo_deal_id) where amo_deal_id is not null;

comment on column public.manual_expenses.amo_deal_id is
  'Сделка AMO (amo_leads.amo_id), к которой относится трата. Без внешнего ключа — см. manual_incomes.amo_deal_id.';

-- ─── Витрина доходов: банк + крипта + ручной ввод ────────────────────────
-- Первые две ветки — один в один из 20260731_0004_crypto_income.sql (сверено
-- с pg_get_viewdef на проде 26.10.2026); пояснения к ним — там. drop + create
-- по той же причине: третья ветка меняет typmod колонок UNION.

drop view if exists public.incomes_v;

create view public.incomes_v as
select
  bt.bank            as source,
  bt.transaction_id  as source_ref,
  bt.occurred_at     as occurred_at,
  (bt.occurred_at at time zone 'Europe/Moscow')::date as occurred_on_msk,
  bt.amount::numeric as amount,
  bt.currency        as currency,
  bt.payer_name      as counterparty,
  bt.payer_inn       as counterparty_inn,
  bt.purpose         as details,
  bt.is_revenue,
  bt.exclude_reason,
  case
    when bt.currency = 'RUB' then bt.amount::numeric
    else bt.amount::numeric * fx.rate
  end as amount_rub
from public.bank_transactions bt
left join lateral (
  select f.rate
  from public.fx_rates f
  where f.currency = bt.currency
    and f.rate_date <= (bt.occurred_at at time zone 'Europe/Moscow')::date
  order by f.rate_date desc
  limit 1
) fx on true
where bt.direction = 'credit'

union all

select
  'crypto_' || lower(ci.token_symbol) as source,
  ci.transfer_id     as source_ref,
  ci.occurred_at     as occurred_at,
  (ci.occurred_at at time zone 'Europe/Moscow')::date as occurred_on_msk,
  ci.amount::numeric as amount,
  ci.currency        as currency,
  ci.from_address    as counterparty,
  null::text         as counterparty_inn,
  ci.transaction_id  as details,
  true               as is_revenue,
  null::text         as exclude_reason,
  ci.amount::numeric * fx.rate as amount_rub
from public.crypto_income_transfers ci
left join lateral (
  select f.rate
  from public.fx_rates f
  where f.currency = case when ci.currency = 'USDT' then 'USD' else ci.currency end
    and f.rate_date <= (ci.occurred_at at time zone 'Europe/Moscow')::date
  order by f.rate_date desc
  limit 1
) fx on true

union all

select
  'manual'           as source,
  mi.id::text        as source_ref,
  -- Время у ручной записи не вводится: полночь московского дня, как у
  -- ручного расхода в expenses_v.
  (mi.occurred_on::timestamp at time zone 'Europe/Moscow') as occurred_at,
  mi.occurred_on     as occurred_on_msk,
  mi.amount::numeric as amount,
  mi.currency        as currency,
  mi.payer           as counterparty,
  null::text         as counterparty_inn,
  -- Способ получения впереди: в списке по дням это единственное место, где
  -- видно, что деньги пришли наличными, а не на счёт.
  concat_ws(' · ', mi.channel, mi.comment) as details,
  -- Решение владельца: ручной доход — всегда выручка (см. шапку).
  true               as is_revenue,
  null::text         as exclude_reason,
  case
    when mi.currency = 'RUB' then mi.amount::numeric
    else mi.amount::numeric * fx.rate
  end as amount_rub
from public.manual_incomes mi
left join lateral (
  select f.rate
  from public.fx_rates f
  where f.currency = mi.currency
    and f.rate_date <= mi.occurred_on
  order by f.rate_date desc
  limit 1
) fx on true;

alter view public.incomes_v set (security_invoker = on);

grant select on public.incomes_v to service_role, postgres;

-- Пересозданная витрина теряет прежние гранты, а read-only коннектор к базе
-- (роль readonly) читал её до этой миграции — возвращаем, как в
-- 20260730_0001_first_sales_dashboard.sql.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.incomes_v, public.manual_incomes to readonly';
  end if;
end $$;

comment on view public.incomes_v is
  'Строка = приход. Источников три: кредит bank_transactions (tochka/tbank, контрагент — плательщик), входящие переводы crypto_income_transfers (crypto_usdt, контрагент — адрес отправителя) и ручной ввод manual_incomes (manual, контрагент — кто принёс, details — способ получения и комментарий). is_revenue=false — не выручка (причина в exclude_reason), потребитель обязан исключать такие строки из итога дохода; у крипты и ручного ввода классификатора нет и is_revenue всегда true.';
