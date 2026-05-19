-- Таблица счетов (выставление счетов клиентам через ЮКассу)
CREATE TABLE IF NOT EXISTS invoices (
  id                   UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name         TEXT          NOT NULL,
  client_user_id       UUID          REFERENCES profiles(id) ON DELETE SET NULL,
  amount               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency             TEXT          NOT NULL DEFAULT 'RUB',
  description          TEXT,
  status               TEXT          NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'paid', 'cancelled', 'expired')),
  yookassa_payment_id  TEXT,
  yookassa_payment_url TEXT,
  created_by           UUID          REFERENCES profiles(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  paid_at              TIMESTAMPTZ,
  metadata             JSONB
);

CREATE INDEX IF NOT EXISTS idx_invoices_created_at     ON invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status         ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_client_user_id ON invoices (client_user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_created_by     ON invoices (created_by);
CREATE INDEX IF NOT EXISTS idx_invoices_yk_payment_id  ON invoices (yookassa_payment_id)
  WHERE yookassa_payment_id IS NOT NULL;

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- Только серверный сервис-роль может читать/писать (через supabaseAdmin)
CREATE POLICY "invoices_service_role_all" ON invoices
  USING (true)
  WITH CHECK (true);

-- Триггер обновления updated_at
CREATE OR REPLACE FUNCTION update_invoices_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_invoices_updated_at();
