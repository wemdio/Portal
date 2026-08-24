-- Фоновый поиск ИНН по сайтам из инструмента «Работа с базами».
--
-- Раньше браузер последовательно отправлял пачки по 5 URL. Закрытие вкладки
-- останавливало цикл, а продолжить с последней строки было невозможно.
-- Job + per-row checkpoints позволяют отдельному worker-контейнеру продолжать
-- обработку без браузера и безопасно применять результаты в spreadsheet state.

create table if not exists public.website_inn_lookup_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  tab_id text not null,
  url_column integer not null check (url_column >= 0),
  inn_column integer not null check (inn_column >= 0),
  company_column integer not null check (company_column >= 0),
  total integer not null default 0 check (total >= 0),
  processed integer not null default 0 check (processed >= 0),
  found integer not null default 0 check (found >= 0),
  cancel_requested boolean not null default false,
  error_message text,
  results_applied_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_website_inn_lookup_one_active_per_user
  on public.website_inn_lookup_jobs (user_id)
  where status in ('pending', 'running');

create index if not exists idx_website_inn_lookup_jobs_pending
  on public.website_inn_lookup_jobs (created_at)
  where status = 'pending';

create index if not exists idx_website_inn_lookup_jobs_user_created
  on public.website_inn_lookup_jobs (user_id, created_at desc);

create table if not exists public.website_inn_lookup_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.website_inn_lookup_jobs(id) on delete cascade,
  row_index integer not null check (row_index > 0),
  url text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  inn text,
  company_name text,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (job_id, row_index)
);

create index if not exists idx_website_inn_lookup_items_pending
  on public.website_inn_lookup_items (job_id, row_index)
  where status = 'pending';

create index if not exists idx_website_inn_lookup_items_terminal
  on public.website_inn_lookup_items (job_id, row_index)
  where status in ('completed', 'failed');

comment on table public.website_inn_lookup_jobs is
  'Возобновляемые серверные прогоны поиска ИНН по сайтам из spreadsheet.';
comment on table public.website_inn_lookup_items is
  'Построчные checkpoints и результаты website_inn_lookup_jobs.';

alter table public.website_inn_lookup_jobs enable row level security;
alter table public.website_inn_lookup_items enable row level security;

drop policy if exists website_inn_lookup_jobs_select_own on public.website_inn_lookup_jobs;
create policy website_inn_lookup_jobs_select_own
  on public.website_inn_lookup_jobs for select
  using (auth.uid() = user_id);

drop policy if exists website_inn_lookup_items_select_own on public.website_inn_lookup_items;
create policy website_inn_lookup_items_select_own
  on public.website_inn_lookup_items for select
  using (
    exists (
      select 1
      from public.website_inn_lookup_jobs j
      where j.id = job_id and auth.uid() = j.user_id
    )
  );

grant all on table public.website_inn_lookup_jobs to service_role;
grant all on table public.website_inn_lookup_items to service_role;
grant select on table public.website_inn_lookup_jobs to authenticated;
grant select on table public.website_inn_lookup_items to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'website_inn_lookup_jobs'
     ) then
    alter publication supabase_realtime add table public.website_inn_lookup_jobs;
  end if;
end
$$;
