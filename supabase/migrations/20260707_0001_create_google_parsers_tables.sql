-- google_maps_jobs
create table public.google_maps_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in (
    'queued','running','paused','stopped','completed','failed',
    'captcha','blocked','timeout','login_required'
  )),
  config jsonb not null default '{}'::jsonb,
  message text,
  total_targets integer not null default 0,
  processed_targets integer not null default 0,
  total_results integer not null default 0,
  proxy_enabled boolean not null default false,
  proxy_encrypted text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);

create index idx_google_maps_jobs_user_id_created_at
  on public.google_maps_jobs(user_id, created_at desc);
create index idx_google_maps_jobs_status
  on public.google_maps_jobs(status)
  where status in ('queued', 'running');

-- google_maps_places
create table public.google_maps_places (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.google_maps_jobs(id) on delete cascade,
  query text,
  name text,
  category text,
  address text,
  phone text,
  website text,
  emails text[],
  linkedin_url text,
  google_maps_url text,
  place_id text,
  rating text,
  reviews_count integer,
  latitude double precision,
  longitude double precision,
  dedupe_key text not null,
  status text,
  created_at timestamptz not null default now()
);

create unique index idx_google_maps_places_job_dedupe
  on public.google_maps_places(job_id, dedupe_key);
create index idx_google_maps_places_job_id
  on public.google_maps_places(job_id);

-- google_news_jobs
create table public.google_news_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in (
    'queued','running','paused','stopped','completed','failed',
    'captcha','blocked','timeout','login_required'
  )),
  config jsonb not null default '{}'::jsonb,
  message text,
  total_targets integer not null default 0,
  processed_targets integer not null default 0,
  total_results integer not null default 0,
  proxy_enabled boolean not null default false,
  proxy_encrypted text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);

create index idx_google_news_jobs_user_id_created_at
  on public.google_news_jobs(user_id, created_at desc);
create index idx_google_news_jobs_status
  on public.google_news_jobs(status)
  where status in ('queued', 'running');

-- google_news_results
create table public.google_news_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.google_news_jobs(id) on delete cascade,
  query text not null,
  position integer,
  title text,
  body text,
  posted text,
  source text,
  link text,
  created_at timestamptz not null default now()
);

create index idx_google_news_results_job_id
  on public.google_news_results(job_id);

-- RLS
alter table public.google_maps_jobs enable row level security;
alter table public.google_maps_places enable row level security;
alter table public.google_news_jobs enable row level security;
alter table public.google_news_results enable row level security;

create policy google_maps_jobs_own on public.google_maps_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy google_maps_places_own on public.google_maps_places
  for all using (
    exists (select 1 from public.google_maps_jobs j where j.id = job_id and j.user_id = auth.uid())
  );

create policy google_news_jobs_own on public.google_news_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy google_news_results_own on public.google_news_results
  for all using (
    exists (select 1 from public.google_news_jobs j where j.id = job_id and j.user_id = auth.uid())
  );
