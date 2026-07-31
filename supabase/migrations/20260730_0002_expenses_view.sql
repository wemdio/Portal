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
