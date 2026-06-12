-- Allows invoices and autopayment subscriptions to target the YooKassa TEST shop
-- (YOOKASSA_TEST_SHOP_ID / YOOKASSA_TEST_SECRET_KEY) instead of the production
-- one. Set per-row at creation time; never mutated afterwards. Drives:
--   - UI badge in /invoices (yellow «🧪 Тест» pill).
--   - Credential selection in lib/yookassa.ts on every subsequent YK call for
--     this invoice (sync status, cancel, recurring charge via saved card).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS is_test_shop BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE client_tariffs
  ADD COLUMN IF NOT EXISTS is_test_shop BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN invoices.is_test_shop IS
  'TRUE = счёт создан через YOOKASSA_TEST_SHOP_ID/SECRET. Влияет на бейдж в UI и креды для get/cancel/sync.';
COMMENT ON COLUMN client_tariffs.is_test_shop IS
  'TRUE = подписка завязана на тестовый магазин YK. Сохранённая карта и cron auto-renew используют тестовые креды.';
