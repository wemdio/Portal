-- AI Caller: server-side job queue for campaign orchestration.
-- Mirrors tg_outreach_jobs pattern: the worker picks pending jobs
-- and drives the call loop server-side (no browser dependency).

create table if not exists public.ai_caller_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ai_campaigns(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (action in ('start','stop')),
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed')),
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists ai_caller_jobs_campaign_idx
  on public.ai_caller_jobs (campaign_id);
create index if not exists ai_caller_jobs_status_idx
  on public.ai_caller_jobs (status) where status = 'pending';

alter table public.ai_caller_jobs enable row level security;

create policy ai_caller_jobs_select_own on public.ai_caller_jobs
  for select to authenticated using (user_id = auth.uid());
create policy ai_caller_jobs_insert_own on public.ai_caller_jobs
  for insert to authenticated with check (user_id = auth.uid());
