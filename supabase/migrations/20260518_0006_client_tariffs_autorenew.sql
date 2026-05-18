-- Автоплатежи: сохранённый метод оплаты ЮКассы + флаг автопродления
ALTER TABLE client_tariffs
  ADD COLUMN IF NOT EXISTS yookassa_payment_method_id TEXT,
  ADD COLUMN IF NOT EXISTS auto_renew                 BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_renewal_error         TEXT,
  ADD COLUMN IF NOT EXISTS last_renewal_attempt_at    TIMESTAMPTZ;

COMMENT ON COLUMN client_tariffs.yookassa_payment_method_id IS
  'Сохранённый ID способа оплаты в ЮКассе для рекуррентных списаний';
COMMENT ON COLUMN client_tariffs.auto_renew IS
  'true — подписка продлевается автоматически каждый месяц';
COMMENT ON COLUMN client_tariffs.last_renewal_error IS
  'Текст последней ошибки при автосписании';
