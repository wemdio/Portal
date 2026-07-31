-- Витрина доходов: приход по счетам + курс валюты.
--
-- Зеркало expenses_v (20260730_0002_expenses_view.sql), но источник ровно
-- один: кредит bank_transactions. Ни Brocard, ни ручных записей на доходной
-- стороне не бывает — карты только тратят, а ручной ввод заведён под личную
-- карту CEO. Поэтому здесь нет UNION и нет колонки `source_kind`: добавлять
-- их «на будущее» значило бы городить пустой слой.
--
-- Разметки (вендоры, правила, категории) у дохода тоже нет. Её роль играет
-- классификатор синка: is_revenue = true — клиентский платёж, false — не
-- выручка, и тогда в exclude_reason лежит причина (возврат, банковская
-- механика, перевод себе). Это прямой аналог категории transfer в расходах:
-- строка видна, но потребитель обязан исключать её из итога дохода.
--
-- Строка без курса ЦБ видна здесь же с amount_rub = NULL — по той же
-- причине, что и в расходах: тихо потерять приход хуже, чем показать его
-- без рублёвого эквивалента.

create or replace view public.incomes_v as
select
  bt.bank            as source,
  bt.transaction_id  as source_ref,
  bt.occurred_at     as occurred_at,
  (bt.occurred_at at time zone 'Europe/Moscow')::date as occurred_on_msk,
  bt.amount          as amount,
  bt.currency        as currency,
  -- Контрагент дохода — плательщик, а не получатель: payee_* у кредитовой
  -- строки это мы сами.
  bt.payer_name      as counterparty,
  bt.payer_inn       as counterparty_inn,
  bt.purpose         as details,
  bt.is_revenue,
  bt.exclude_reason,
  case
    when bt.currency = 'RUB' then bt.amount
    else bt.amount * fx.rate
  end as amount_rub
from public.bank_transactions bt
left join lateral (
  -- Ближайший курс НЕ ПОЗЖЕ даты операции: ЦБ не публикует курс в выходные
  -- и праздники, поэтому join по равенству дат оставил бы такие приходы без
  -- рублёвой суммы. Один в один с expenses_v — арифметика конвертации на
  -- обеих сторонах обязана быть одинаковой, иначе доход и расход перестанут
  -- сравниваться между собой.
  select f.rate
  from public.fx_rates f
  where f.currency = bt.currency
    and f.rate_date <= (bt.occurred_at at time zone 'Europe/Moscow')::date
  order by f.rate_date desc
  limit 1
) fx on true
where bt.direction = 'credit';

-- Новых индексов не требуется: фильтр по направлению и дате закрывает
-- idx_bank_tx_direction_date (direction, occurred_at desc) из
-- 20260730_0001_expenses_core.sql, поиск курса — idx_fx_rates_currency_date
-- из 20260730_0004_expenses_indexes.sql. Оговорка оттуда же в силе и здесь:
-- функциональный индекс на occurred_on_msk создать нельзя (AT TIME ZONE над
-- timestamptz помечен STABLE), поэтому фильтр периода идёт построчно.

alter view public.incomes_v set (security_invoker = on);

grant select on public.incomes_v to service_role, postgres;

comment on view public.incomes_v is
  'Строка = приход. Источник один: кредит bank_transactions (tochka/tbank), контрагент — плательщик. is_revenue=false — не выручка (причина в exclude_reason), потребитель обязан исключать такие строки из итога дохода.';
