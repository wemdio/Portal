create table if not exists public.yandex_maps_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending','running','completed','failed')),
  config jsonb not null default '{}'::jsonb,
  progress_stage text,
  total_links integer default 0,
  processed_links integer default 0,
  total_organizations integer default 0,
  processed_organizations integer default 0,
  proxy_enabled boolean not null default false,
  proxy_protocol text,
  proxy_host text,
  proxy_port text,
  proxy_credentials_encrypted text,
  created_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  error_message text
);

create table if not exists public.yandex_maps_links (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.yandex_maps_jobs(id) on delete cascade,
  link text not null,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists idx_yandex_maps_links_job_link_unique
  on public.yandex_maps_links(job_id, link);

create index if not exists idx_yandex_maps_links_job_id
  on public.yandex_maps_links(job_id);

create table if not exists public.yandex_maps_organizations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.yandex_maps_jobs(id) on delete cascade,
  name text,
  country text,
  city text,
  address text,
  rating text,
  reviews_count text,
  website text,
  email text,
  phone text,
  telegram text,
  vk text,
  instagram text,
  whatsapp text,
  card_url text,
  working_hours text,
  categories text,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_yandex_maps_organizations_job_id
  on public.yandex_maps_organizations(job_id);

create unique index if not exists idx_yandex_maps_organizations_job_card_url_unique
  on public.yandex_maps_organizations(job_id, card_url);

alter table public.yandex_maps_jobs enable row level security;
alter table public.yandex_maps_links enable row level security;
alter table public.yandex_maps_organizations enable row level security;

drop policy if exists yandex_maps_jobs_select_own on public.yandex_maps_jobs;
create policy yandex_maps_jobs_select_own
  on public.yandex_maps_jobs for select
  using (auth.uid() = user_id);

drop policy if exists yandex_maps_jobs_insert_own on public.yandex_maps_jobs;
create policy yandex_maps_jobs_insert_own
  on public.yandex_maps_jobs for insert
  with check (auth.uid() = user_id);

drop policy if exists yandex_maps_jobs_update_own on public.yandex_maps_jobs;
create policy yandex_maps_jobs_update_own
  on public.yandex_maps_jobs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists yandex_maps_jobs_delete_own on public.yandex_maps_jobs;
create policy yandex_maps_jobs_delete_own
  on public.yandex_maps_jobs for delete
  using (auth.uid() = user_id);

drop policy if exists yandex_maps_links_select_own_job on public.yandex_maps_links;
create policy yandex_maps_links_select_own_job
  on public.yandex_maps_links for select
  using (
    exists (
      select 1 from public.yandex_maps_jobs j
      where j.id = yandex_maps_links.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists yandex_maps_links_insert_own_job on public.yandex_maps_links;
create policy yandex_maps_links_insert_own_job
  on public.yandex_maps_links for insert
  with check (
    exists (
      select 1 from public.yandex_maps_jobs j
      where j.id = yandex_maps_links.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists yandex_maps_links_delete_own_job on public.yandex_maps_links;
create policy yandex_maps_links_delete_own_job
  on public.yandex_maps_links for delete
  using (
    exists (
      select 1 from public.yandex_maps_jobs j
      where j.id = yandex_maps_links.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists yandex_maps_organizations_select_own_job on public.yandex_maps_organizations;
create policy yandex_maps_organizations_select_own_job
  on public.yandex_maps_organizations for select
  using (
    exists (
      select 1 from public.yandex_maps_jobs j
      where j.id = yandex_maps_organizations.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists yandex_maps_organizations_insert_own_job on public.yandex_maps_organizations;
create policy yandex_maps_organizations_insert_own_job
  on public.yandex_maps_organizations for insert
  with check (
    exists (
      select 1 from public.yandex_maps_jobs j
      where j.id = yandex_maps_organizations.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists yandex_maps_organizations_delete_own_job on public.yandex_maps_organizations;
create policy yandex_maps_organizations_delete_own_job
  on public.yandex_maps_organizations for delete
  using (
    exists (
      select 1 from public.yandex_maps_jobs j
      where j.id = yandex_maps_organizations.job_id
        and j.user_id = auth.uid()
    )
  );

