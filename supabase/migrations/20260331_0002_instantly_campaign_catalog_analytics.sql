-- Adds analytics columns to instantly_campaign_catalog so client-portal reads
-- are served entirely from the DB (worker syncs from Instantly API hourly).
-- Columns mirror the CampaignAnalytics interface fields used by the client view.

alter table public.instantly_campaign_catalog
  add column if not exists emails_sent_count    integer,
  add column if not exists open_count           integer,
  add column if not exists reply_count          integer,
  add column if not exists new_leads_contacted_count integer,
  add column if not exists bounced_count        integer,
  add column if not exists unsubscribed_count   integer,
  add column if not exists analytics_synced_at  timestamptz;

comment on column public.instantly_campaign_catalog.analytics_synced_at is
  'Timestamp of the last successful analytics sync from Instantly API';
