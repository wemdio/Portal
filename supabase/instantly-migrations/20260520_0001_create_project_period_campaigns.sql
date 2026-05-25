-- Period-scoped links between Portal project periods and Instantly campaigns.
-- Lives in PolzaInstantlyDB; project_id/period_id point to the main DB logically, not by FK.

create table if not exists public.project_period_instantly_campaigns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  period_id uuid not null,
  campaign_id text not null,
  match_source text not null default 'auto'
    check (match_source in ('auto', 'manual', 'auto-text', 'auto-ai')),
  baseline_contacts integer not null default 0,
  match_confidence numeric,
  match_reason text,
  created_at timestamptz not null default now(),
  unique(period_id, campaign_id)
);

create index if not exists idx_project_period_campaigns_project
  on public.project_period_instantly_campaigns(project_id);

create index if not exists idx_project_period_campaigns_period
  on public.project_period_instantly_campaigns(period_id);

create index if not exists idx_project_period_campaigns_campaign
  on public.project_period_instantly_campaigns(campaign_id);

alter table public.project_period_instantly_campaigns enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.project_period_instantly_campaigns to service_role;
  end if;

  if exists (select 1 from pg_roles where rolname = 'instantly') then
    grant all on public.project_period_instantly_campaigns to instantly;
  end if;
end $$;

drop policy if exists "Service role full access on project_period_instantly_campaigns" on public.project_period_instantly_campaigns;
create policy "Service role full access on project_period_instantly_campaigns"
  on public.project_period_instantly_campaigns for all using (true) with check (true);
