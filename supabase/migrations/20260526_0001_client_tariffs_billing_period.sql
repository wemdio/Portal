-- Период оплаты подписки и зафиксированная сумма для выставления счёта.
-- При активации тарифа админ выбирает период (месяц / полгода / год),
-- сумма рассчитывается и сохраняется здесь — потом подставляется в счёт.
ALTER TABLE client_tariffs
  ADD COLUMN IF NOT EXISTS billing_period   TEXT,
  ADD COLUMN IF NOT EXISTS billing_amount   NUMERIC(12, 2);

-- Допустимые значения периода
ALTER TABLE client_tariffs
  DROP CONSTRAINT IF EXISTS client_tariffs_billing_period_check;
ALTER TABLE client_tariffs
  ADD CONSTRAINT client_tariffs_billing_period_check
  CHECK (billing_period IS NULL OR billing_period IN ('month', 'half_year', 'year'));

COMMENT ON COLUMN client_tariffs.billing_period IS
  'Период оплаты подписки: month (1 мес), half_year (6 мес), year (12 мес). NULL — не выбран.';
COMMENT ON COLUMN client_tariffs.billing_amount IS
  'Зафиксированная сумма к оплате за выбранный период. Используется при выставлении счёта.';
