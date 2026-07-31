-- Крипто-приход: входящие переводы USDT (TRC-20, сеть Tron) → отдельное сырьё
-- + второй источник в витрине доходов.
--
-- Почему НЕ в bank_transactions. Это не банк: у перевода нет ни номера
-- документа, ни ИНН, ни назначения платежа, а идентификатор — хеш транзакции
-- блокчейна, а не (bank, transaction_id). Класть крипту в банковскую таблицу
-- значило бы половину колонок держать вечно пустыми, а уникальность
-- натягивать на чужой ключ. Тот же принцип, что у brocard_transactions в
-- 20260730_0001_expenses_core.sql: у каждого источника своё честное сырьё,
-- общая только витрина.

-- ─── Сырьё: входящие переводы токена ─────────────────────────────────────
-- Тянем ТОЛЬКО входящие (решение владельца) — поэтому колонки direction тут
-- нет вовсе. Появится исходящая сторона — она приедет со своей колонкой и
-- своим осознанным решением, а не будет молча подразумеваться сейчас.

create table if not exists public.crypto_income_transfers (
  id             bigserial primary key,
  -- Идентификатор ПЕРЕВОДА, а не транзакции: в одной транзакции блокчейна
  -- может быть несколько переводов токена (реальный пример в мейннете —
  -- tx e853aabe… с двумя Transfer-логами, event_index 0 и 1). Уникальность
  -- по transaction_id схлопнула бы такую пару в одну строку и молча
  -- потеряла бы деньги. Как именно собирается transfer_id — см. докстринг
  -- services/portal-external-sync/sources/crypto_usdt.py.
  transfer_id    text        not null unique,
  -- Хеш транзакции блокчейна. НЕ уникален (см. выше) — это то, что человек
  -- вставляет в обозреватель блоков, чтобы посмотреть перевод глазами.
  transaction_id text        not null,
  network        text        not null default 'tron',
  token_symbol   text        not null,
  -- Адрес контракта токена. Отличает настоящий USDT от одноимённого
  -- скам-токена: символ в блокчейне никем не защищён, контракт — защищён.
  token_contract text        not null,
  -- Наш кошелёк (получатель перевода). Хранится в строке, а не берётся из
  -- окружения при чтении: смена кошелька не должна задним числом
  -- переподписывать уже приехавшую историю.
  wallet_address text        not null,
  from_address   text        not null,
  occurred_at    timestamptz not null,
  amount         numeric(38,6) not null,
  currency       text        not null,
  raw            jsonb       not null,
  synced_at      timestamptz not null default now()
);

create index if not exists idx_crypto_income_occurred_at
  on public.crypto_income_transfers (occurred_at desc);
create index if not exists idx_crypto_income_from
  on public.crypto_income_transfers (from_address);
create index if not exists idx_crypto_income_transaction
  on public.crypto_income_transfers (transaction_id);

comment on table public.crypto_income_transfers is
  'Строка = один входящий перевод токена на кошелёк студии. Только входящие: исходящие переводы намеренно не тянем. Сырьё, трактовки — в incomes_v.';
comment on column public.crypto_income_transfers.transfer_id is
  'Уникальность на уровне перевода, а не транзакции: в одной транзакции блокчейна бывает несколько переводов токена.';
comment on column public.crypto_income_transfers.amount is
  'Сумма в единицах токена — value из API уже поделён на 10^decimals (у USDT decimals=6).';
comment on column public.crypto_income_transfers.currency is
  'Символ токена (USDT). В incomes_v при поиске курса подменяется на USD — см. комментарий там же.';

-- ─── Новый источник в логе синка ─────────────────────────────────────────
-- external_sync_runs.source — CHECK со списком имён. main.py пишет запись о
-- прогоне ДО вызова источника и делает это вне try/except (см. run_all()),
-- поэтому незарегистрированное имя роняет не один источник, а весь ночной
-- цикл целиком. Тот же приём, что в 20260730_0001_expenses_core.sql и
-- 20260731_0003_meeting_links_sync_source.sql.
--
-- Список продолжает актуальный из 20260731_0003_meeting_links_sync_source.sql
-- (именно оттуда, а не из 20260730_0001 — иначе потерялся бы 'meeting_links'),
-- полностью и без сокращений.
--
-- ВНИМАНИЕ на порядок файлов: 20260731_0003_… сортируется ПОСЛЕ этой миграции,
-- и при накатке всей папки с нуля он выполнится последним, перезаписав
-- констрейнт своим списком. Поэтому 'crypto_usdt' добавлен и туда тоже —
-- оба файла обязаны нести одинаковый полный список, иначе на свежей базе
-- ночной цикл упадёт целиком на первом же прогоне.

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
    'expense_rules',
    'meeting_links',
    'crypto_usdt'
  ));

-- ─── RLS ─────────────────────────────────────────────────────────────────
-- Как и у расходов: select-политики для authenticated намеренно нет, читает
-- только серверный код под service_role через API-роуты с гардом доступа.

alter table public.crypto_income_transfers enable row level security;

grant all on public.crypto_income_transfers to service_role, postgres;
grant usage, select on sequence public.crypto_income_transfers_id_seq
  to service_role, postgres;

-- ─── Витрина доходов: банк + крипта ──────────────────────────────────────
-- До этой миграции incomes_v (20260731_0001_incomes_view.sql) знала ровно
-- один источник — кредит bank_transactions — и потому обходилась без UNION.
-- Теперь источников два, форма строки у них обязана совпадать: потребитель
-- (app/src/lib/expenses/rows.ts) читает фиксированный список колонок и
-- пагинирует по (occurred_on_msk, source_ref).
--
-- drop + create, а не create or replace: CREATE OR REPLACE VIEW требует
-- совпадения типов колонок, а UNION банковского numeric(14,2) с крипто-
-- numeric(38,6) даёт другой typmod — замена на месте упала бы.

drop view if exists public.incomes_v;

create view public.incomes_v as
select
  bt.bank            as source,
  bt.transaction_id  as source_ref,
  bt.occurred_at     as occurred_at,
  (bt.occurred_at at time zone 'Europe/Moscow')::date as occurred_on_msk,
  bt.amount::numeric as amount,
  bt.currency        as currency,
  -- Контрагент дохода — плательщик, а не получатель: payee_* у кредитовой
  -- строки это мы сами.
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
where bt.direction = 'credit'

union all

select
  -- 'crypto_usdt' целиком, а не 'crypto': источник в витрине обязан называть
  -- конкретный токен — второй токен на том же кошельке не должен слиться с
  -- первым в одну строку фильтра.
  'crypto_' || lower(ci.token_symbol) as source,
  ci.transfer_id     as source_ref,
  ci.occurred_at     as occurred_at,
  (ci.occurred_at at time zone 'Europe/Moscow')::date as occurred_on_msk,
  ci.amount::numeric as amount,
  ci.currency        as currency,
  -- Контрагент — адрес отправителя. Классификатора «выручка / не выручка» у
  -- крипты нет (у перевода нет ни ИНН, ни назначения платежа), поэтому
  -- именно адрес — единственное, по чему человек глазами отличит платёж
  -- клиента от перевода с собственного кошелька. Он обязан быть виден.
  ci.from_address    as counterparty,
  null::text         as counterparty_inn,
  -- Хеш транзакции: то, что вставляют в обозреватель блоков, чтобы
  -- посмотреть перевод целиком.
  ci.transaction_id  as details,
  -- Входящий перевод считаем выручкой (решение владельца). Это осознанно
  -- более грубо, чем банковский классификатор: возврат или перевод себе
  -- здесь попадёт в выручку, и увидеть это можно только по адресу
  -- отправителя в counterparty — см. комментарий выше.
  true               as is_revenue,
  null::text         as exclude_reason,
  ci.amount::numeric * fx.rate as amount_rub
from public.crypto_income_transfers ci
left join lateral (
  select f.rate
  from public.fx_rates f
  -- USDT считаем по курсу ДОЛЛАРА ЦБ. Это осознанное упрощение, а не
  -- совпадение имён: стейблкоин привязан к доллару один к одному, и
  -- отдельный источник котировок под него владелец заводить не стал.
  -- Ровно та же подмена продублирована в сборщике дат
  -- services/portal-external-sync/sources/fx_cbr.py — без неё fx_rates за
  -- нужные дни просто не появится, и amount_rub у крипты останется NULL.
  -- Меняются оба места только вместе.
  where f.currency = case when ci.currency = 'USDT' then 'USD' else ci.currency end
    and f.rate_date <= (ci.occurred_at at time zone 'Europe/Moscow')::date
  order by f.rate_date desc
  limit 1
) fx on true;

-- Индексы: банковская сторона закрыта idx_bank_tx_direction_date
-- (20260730_0001_expenses_core.sql), крипто-сторона —
-- idx_crypto_income_occurred_at выше, поиск курса —
-- idx_fx_rates_currency_date (20260730_0004_expenses_indexes.sql). Оговорка
-- оттуда же в силе: функциональный индекс на occurred_on_msk создать нельзя
-- (AT TIME ZONE над timestamptz помечен STABLE), поэтому фильтр периода
-- идёт построчно.

alter view public.incomes_v set (security_invoker = on);

grant select on public.incomes_v to service_role, postgres;

comment on view public.incomes_v is
  'Строка = приход. Источника два: кредит bank_transactions (tochka/tbank, контрагент — плательщик) и входящие переводы crypto_income_transfers (crypto_usdt, контрагент — адрес отправителя). is_revenue=false — не выручка (причина в exclude_reason), потребитель обязан исключать такие строки из итога дохода; у крипты классификатора нет и is_revenue всегда true.';
