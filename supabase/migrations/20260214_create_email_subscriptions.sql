-- Email subscriptions billing calendar table
-- Tracks email account billing dates for projects
-- Technicians create/edit entries, Leads approve/cancel before billing

CREATE TABLE IF NOT EXISTS email_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Project reference
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_name TEXT NOT NULL,
  
  -- Email details
  email_provider TEXT NOT NULL DEFAULT '',        -- e.g. "Google Workspace", "Zoho Mail"
  email_count INTEGER NOT NULL DEFAULT 1,         -- number of email accounts
  
  -- Billing info
  next_billing_date DATE NOT NULL,
  billing_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly'    -- monthly, quarterly, yearly
    CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  
  -- Status workflow
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_review', 'keep', 'cancel', 'expired')),
  
  -- Lead decision
  lead_decision TEXT                               -- 'keep' or 'cancel'
    CHECK (lead_decision IS NULL OR lead_decision IN ('keep', 'cancel')),
  lead_decision_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  lead_decision_at TIMESTAMPTZ,
  lead_notes TEXT,
  
  -- Audit
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

-- Index for calendar queries (by date range)
CREATE INDEX idx_email_subscriptions_billing_date ON email_subscriptions(next_billing_date);
CREATE INDEX idx_email_subscriptions_status ON email_subscriptions(status);
CREATE INDEX idx_email_subscriptions_project ON email_subscriptions(project_id);

-- Enable RLS
ALTER TABLE email_subscriptions ENABLE ROW LEVEL SECURITY;

-- Policy: all authenticated users can read
CREATE POLICY "email_subscriptions_select" ON email_subscriptions
  FOR SELECT TO authenticated
  USING (true);

-- Policy: technicians, leads, admins, directors can insert
CREATE POLICY "email_subscriptions_insert" ON email_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Policy: technicians, leads, admins, directors can update
CREATE POLICY "email_subscriptions_update" ON email_subscriptions
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

-- Policy: admins and directors can delete
CREATE POLICY "email_subscriptions_delete" ON email_subscriptions
  FOR DELETE TO authenticated
  USING (true);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_email_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_subscriptions_updated_at
  BEFORE UPDATE ON email_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_email_subscriptions_updated_at();
