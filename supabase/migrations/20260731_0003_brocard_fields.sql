-- Brocard: направление, тип операции и связь с платежом.
--
-- Строка brocard_transactions = движение по балансу карты
-- (GET /api/v2/balance/history), а не покупка: комиссии есть только в истории
-- баланса, и их там больше, чем самих покупок (на живой карте 100 payment_fee
-- + 40 declined_payment_fee против 89 payment). Мерчант, наоборот, есть
-- только в /api/v2/payments, и переносится на движение по based_on_id.
--
-- Колонок под три вещи из этого не хватало:
--   * направление операции, которое API отдаёт отдельно от суммы;
--   * тип движения (покупка / комиссия / комиссия за отказ / возврат);
--   * id платежа, через который к движению приклеен мерчант.
-- Без первых двух знак в amount становится нечитаемым (см. ниже), без
-- третьего связь «комиссия → сервис» нельзя проверить запросом, только
-- разбирая jsonb руками.

alter table public.brocard_transactions
  add column if not exists direction      text,
  add column if not exists operation_type text,
  add column if not exists payment_id     text;

create index if not exists idx_brocard_tx_payment_id
  on public.brocard_transactions (payment_id) where payment_id is not null;
create index if not exists idx_brocard_tx_operation_type
  on public.brocard_transactions (operation_type);

comment on column public.brocard_transactions.direction is
  'Направление, как его отдал Brocard: outcome (деньги ушли с карты) | income. Специально без CHECK: новое значение должно приезжать в базу и попадать в сводку синка, а не ронять заливку. Знак amount задаётся этим полем вместе с operation_type, а не знаком из ответа API.';

comment on column public.brocard_transactions.operation_type is
  'Тип движения по балансу: payment | payment_fee | declined_payment_fee | payment_void и всё, что Brocard заведёт дальше. declined_payment_fee — комиссия за отклонённую попытку: сам платёж деньгами не стал и строки не даёт, а комиссия за отказ стала и учитывается как трата.';

comment on column public.brocard_transactions.payment_id is
  'based_on_id движения — платёж из /api/v2/payments, откуда взяты merchant, merchant_category, holder и status. У payment это сам платёж, у payment_fee и declined_payment_fee — платёж, за который взята комиссия, у payment_void — гасимый платёж. NULL — движение с платежом связать не удалось.';

-- Знак суммы. Витрина expenses_v просто складывает amount по всем источникам,
-- отдельного поля направления у неё нет, поэтому смысл знака здесь такой:
-- трата > 0, возврат < 0. Записать "-0.88" из ответа API как есть значило бы
-- вычитать траты из расходов; записать возврат положительным — считать его
-- ещё одной тратой. Направление операции при этом не выводится из знака, оно
-- лежит рядом в direction.
comment on column public.brocard_transactions.amount is
  'Сумма в валюте карты, со знаком для витрины: трата положительная, возврат (operation_type=payment_void) отрицательный — он гасит ранее учтённую трату, а не добавляет доход. Исходное направление — в колонке direction, исходная сумма покупки в валюте мерчанта (initial_amount/initial_currency платежа) — в raw. amount_account/currency_account у этого источника не заполняются: движение по балансу и есть списание со счёта.';
