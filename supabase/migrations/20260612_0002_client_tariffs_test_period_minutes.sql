-- QA-only knob: when test_period_minutes is set on a client_tariffs row, the
-- autopayment cycle uses that many minutes instead of 1 month for every
-- paid_until extension (first payment via webhook, and every cron renewal).
-- Lets us exercise the full save-card → cron-charge → extend loop in minutes
-- against the production YooKassa shop without waiting a real month.
--
-- Set via admin /users → SubscriptionPanel «🧪 Тест» mode. Never touched on
-- production-grade activations (which leave it NULL, so all calculators fall
-- back to the standard "+1 month" path).
ALTER TABLE client_tariffs
  ADD COLUMN IF NOT EXISTS test_period_minutes INTEGER;

COMMENT ON COLUMN client_tariffs.test_period_minutes IS
  'QA only: when set, autopayment paid_until is extended by N minutes instead of 1 month. NULL on production-grade subscriptions.';
