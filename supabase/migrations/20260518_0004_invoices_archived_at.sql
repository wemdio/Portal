ALTER TABLE invoices ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_invoices_archived_at ON invoices (archived_at) WHERE archived_at IS NOT NULL;
