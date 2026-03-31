-- Adds leads_count column for report "total leads" metric, missed in previous migration.

alter table public.instantly_campaign_catalog
  add column if not exists leads_count integer;
