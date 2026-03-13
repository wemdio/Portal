-- LPR (decision-maker) discovery: jobs and candidates

create table if not exists public.lpr_jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  status          text not null check (status in ('pending','running','completed','failed')),
  config          jsonb not null default '{}'::jsonb,
  total_found     integer not null default 0,
  enriched_count  integer not null default 0,
  usable_count    integer not null default 0,
  apollo_credits  integer not null default 0,
  pdl_credits     integer not null default 0,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  error_message   text
);

create index if not exists idx_lpr_jobs_user_status on public.lpr_jobs(user_id, status);

create table if not exists public.lpr_candidates (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.lpr_jobs(id) on delete cascade,
  apollo_id         text,
  pdl_id            text,
  full_name         text not null,
  first_name        text,
  last_name         text,
  title             text,
  seniority         text,
  function_area     text,
  company_name      text,
  company_domain    text,
  work_email        text,
  personal_email    text,
  phone             text,
  linkedin_url      text,
  score             integer not null default 0,
  enrichment_source text not null default 'none' check (enrichment_source in ('apollo','pdl','both','none')),
  pdl_likelihood    integer,
  data_freshness    timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists idx_lpr_candidates_job_id on public.lpr_candidates(job_id);
create index if not exists idx_lpr_candidates_score on public.lpr_candidates(job_id, score desc);

-- Cache: avoid re-querying the same company within TTL
create table if not exists public.lpr_cache (
  company_key     text primary key,  -- domain or normalized company_name
  job_id          uuid not null references public.lpr_jobs(id) on delete cascade,
  cached_at       timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index if not exists idx_lpr_cache_expires on public.lpr_cache(expires_at);

-- RLS
alter table public.lpr_jobs enable row level security;
alter table public.lpr_candidates enable row level security;
alter table public.lpr_cache enable row level security;

-- Jobs: own rows
drop policy if exists lpr_jobs_select_own on public.lpr_jobs;
create policy lpr_jobs_select_own on public.lpr_jobs for select using (auth.uid() = user_id);

drop policy if exists lpr_jobs_insert_own on public.lpr_jobs;
create policy lpr_jobs_insert_own on public.lpr_jobs for insert with check (auth.uid() = user_id);

drop policy if exists lpr_jobs_update_own on public.lpr_jobs;
create policy lpr_jobs_update_own on public.lpr_jobs for update using (auth.uid() = user_id);

-- Candidates: via job ownership
drop policy if exists lpr_candidates_select_own on public.lpr_candidates;
create policy lpr_candidates_select_own on public.lpr_candidates for select using (
  exists (select 1 from public.lpr_jobs j where j.id = lpr_candidates.job_id and j.user_id = auth.uid())
);

drop policy if exists lpr_candidates_insert_own on public.lpr_candidates;
create policy lpr_candidates_insert_own on public.lpr_candidates for insert with check (
  exists (select 1 from public.lpr_jobs j where j.id = lpr_candidates.job_id and j.user_id = auth.uid())
);

-- Cache: service-role only (no user RLS policy)
