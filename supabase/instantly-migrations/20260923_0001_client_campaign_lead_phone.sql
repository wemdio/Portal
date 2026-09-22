-- Preserve uploaded lead phones in the operational Instantly cache so a
-- transient lead-lookup failure cannot erase them from a new board row.
alter table public.client_campaign_leads add column if not exists phone text;
