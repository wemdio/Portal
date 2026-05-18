-- Exact registration date (from DaData by INN) for the event-outreach tool.
-- Enables month-precise anniversary targeting instead of OGRN-year only.

ALTER TABLE public.event_outreach_leads
  ADD COLUMN IF NOT EXISTS registration_date date,
  ADD COLUMN IF NOT EXISTS anniversary_date date,
  ADD COLUMN IF NOT EXISTS days_to_anniversary integer;

COMMENT ON COLUMN public.event_outreach_leads.registration_date IS
  'Exact company registration date from DaData (by INN); null when unresolved.';
COMMENT ON COLUMN public.event_outreach_leads.anniversary_date IS
  'Date of the next round-number anniversary, when the company hits a milestone.';
COMMENT ON COLUMN public.event_outreach_leads.days_to_anniversary IS
  'Days from the collect run to anniversary_date.';
