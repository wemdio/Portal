-- Per-job execution logs for the Google Maps / Google News parsers.
--
-- The worker (`portal-worker-googleparsers`) and the parser service
-- (`services/googleparsers`) stream key inflection points here so the UI
-- can surface "why did my job fail?" without SSH to the box.
--
-- One table covers both job kinds — job_id is intentionally NOT a foreign
-- key (would require two nullable FK columns or dispatch on trigger). RLS
-- enforces ownership via the two EXISTS checks below, mirroring the
-- foreign key semantics for read access.
create table public.google_parsers_logs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  job_kind text not null check (job_kind in ('maps', 'news')),
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  message text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index idx_google_parsers_logs_job_id_created_at
  on public.google_parsers_logs(job_id, created_at asc);
create index idx_google_parsers_logs_created_at
  on public.google_parsers_logs(created_at desc);

alter table public.google_parsers_logs enable row level security;

-- Read-own via join to the parent job (Maps or News).
create policy google_parsers_logs_select_own on public.google_parsers_logs
  for select using (
    (job_kind = 'maps' and exists (
      select 1 from public.google_maps_jobs j where j.id = job_id and j.user_id = auth.uid()
    ))
    or
    (job_kind = 'news' and exists (
      select 1 from public.google_news_jobs j where j.id = job_id and j.user_id = auth.uid()
    ))
  );

grant all on public.google_parsers_logs to service_role;
grant select on public.google_parsers_logs to authenticated;
