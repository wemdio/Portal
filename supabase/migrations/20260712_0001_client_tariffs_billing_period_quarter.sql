-- Добавляем 'quarter' (3 месяца) в допустимые значения billing_period.
-- Расширяем существующий check-constraint. В TS-коде (lib/tariffs.ts,
-- api/client/payment/route.ts) quarter уже поддерживается, но в БД
-- constraint от миграции 20260526 разрешал только month/half_year/year,
-- поэтому попытка создать подписку на 3 мес падала с ошибкой
-- client_tariffs_billing_period_check.
ALTER TABLE client_tariffs
  DROP CONSTRAINT IF EXISTS client_tariffs_billing_period_check;
ALTER TABLE client_tariffs
  ADD CONSTRAINT client_tariffs_billing_period_check
  CHECK (billing_period IS NULL OR billing_period IN ('month', 'quarter', 'half_year', 'year'));

COMMENT ON COLUMN client_tariffs.billing_period IS
  'Период оплаты подписки: month (1 мес), quarter (3 мес), half_year (6 мес), year (12 мес). NULL — не выбран.';
