-- Cached Instantly campaign list for tools (auto-report UI). Full analytics still fetched per campaign on report build.
-- Populated by server sync (cron + background); service role only — RLS enabled with no user policies.

create table if not exists public.instantly_campaign_catalog (
  id uuid primary key,
  name text not null default '',
  status integer,
  timestamp_created timestamptz,
  timestamp_updated timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists idx_instantly_campaign_catalog_synced_at
  on public.instantly_campaign_catalog (synced_at desc);

create index if not exists idx_instantly_campaign_catalog_updated
  on public.instantly_campaign_catalog (timestamp_updated desc nulls last);

alter table public.instantly_campaign_catalog enable row level security;

comment on table public.instantly_campaign_catalog is
  'Instantly campaign id/name cache for portal tools; synced periodically from api.instantly.ai';
