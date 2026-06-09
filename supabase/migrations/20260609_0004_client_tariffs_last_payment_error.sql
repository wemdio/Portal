-- Последняя ошибка клиентской попытки оплаты в YooKassa (из webhook payment.canceled).
-- Отличается от last_renewal_error: тот про cron-автосписания с сохранённой карты,
-- этот — про осознанные клиентские попытки через ссылку из ЛК.
-- Текст уже маппится в русские строки (см. mapYookassaErrorRu) для прямого показа в UI.
ALTER TABLE client_tariffs
  ADD COLUMN IF NOT EXISTS last_payment_error TEXT;

COMMENT ON COLUMN client_tariffs.last_payment_error IS
  'Последняя ошибка попытки оплаты клиентом (из webhook payment.canceled), '
  'короткий русский текст для прямого показа в ЛК.';
