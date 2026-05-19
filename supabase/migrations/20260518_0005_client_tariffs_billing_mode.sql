-- Режим выставления счетов для подписки клиента
ALTER TABLE client_tariffs
  ADD COLUMN IF NOT EXISTS billing_mode TEXT
    CHECK (billing_mode IN ('invoice', 'autopayment')),
  ADD COLUMN IF NOT EXISTS payment_locked BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN client_tariffs.billing_mode IS
  'invoice = счёт выставляется вручную из вкладки Счета, автоматическая разблокировка при оплате; '
  'autopayment = клиент платит сам через ЛК, лок снимается после setup_until или вручную';

COMMENT ON COLUMN client_tariffs.payment_locked IS
  'true — доступ к функционалу ЛК заблокирован до оплаты';
