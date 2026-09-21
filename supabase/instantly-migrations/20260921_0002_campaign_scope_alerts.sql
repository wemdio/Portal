-- Deduplicated audit state for manual Instantly campaigns that accidentally
-- use a reserve-mailbox tag ("неименные ...") as a campaign/project tag.
-- The audit only sends a Telegram warning; it never pauses provider campaigns.

create table if not exists public.instantly_campaign_scope_alerts (
  instantly_account_id text not null,
  campaign_id text not null,
  campaign_name text not null default '',
  campaign_status integer,
  reserve_tag_ids text[] not null default '{}',
  reserve_tag_names text[] not null default '{}',
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  last_alerted_at timestamptz,
  last_alert_error text,
  resolved_at timestamptz,
  primary key (instantly_account_id, campaign_id)
);

create index if not exists instantly_campaign_scope_alerts_open_idx
  on public.instantly_campaign_scope_alerts (instantly_account_id, last_detected_at desc)
  where resolved_at is null;

alter table public.instantly_campaign_scope_alerts enable row level security;

drop policy if exists "Service role full access on instantly_campaign_scope_alerts"
  on public.instantly_campaign_scope_alerts;
create policy "Service role full access on instantly_campaign_scope_alerts"
  on public.instantly_campaign_scope_alerts
  for all
  using (true)
  with check (true);

comment on table public.instantly_campaign_scope_alerts is
  'Deduplicates lead-topic warnings for manual campaigns using reserve mailbox tags; does not change provider state.';
