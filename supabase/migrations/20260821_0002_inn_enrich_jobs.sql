-- inn_enrich_jobs: серверные прогоны тула /tools/inn-enrich.
--
-- v1 держал матчинг во вкладке: ушёл / перезагрузил — результат пропал.
-- Теперь исходный файл лежит в private bucket, воркер (portal-worker)
-- обогащает и кладёт готовый xlsx. История + скачивание переживают
-- закрытие вкладки.

create table if not exists public.inn_enrich_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending','running','completed','failed')),
  file_name text not null,
  source_path text,
  result_path text,
  column_index integer not null default 0,
  has_header boolean not null default true,
  total integer not null default 0,
  processed integer not null default 0,
  stats jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists idx_inn_enrich_jobs_user_created
  on public.inn_enrich_jobs (user_id, created_at desc);
create index if not exists idx_inn_enrich_jobs_pending
  on public.inn_enrich_jobs (created_at)
  where status = 'pending';

comment on table public.inn_enrich_jobs is
  'Прогоны обогащения файла по ИНН из companies_directory; артефакты в bucket inn-enrich-exports.';

alter table public.inn_enrich_jobs enable row level security;

drop policy if exists inn_enrich_jobs_select_own on public.inn_enrich_jobs;
create policy inn_enrich_jobs_select_own
  on public.inn_enrich_jobs for select using (auth.uid() = user_id);

drop policy if exists inn_enrich_jobs_insert_own on public.inn_enrich_jobs;
create policy inn_enrich_jobs_insert_own
  on public.inn_enrich_jobs for insert with check (auth.uid() = user_id);

drop policy if exists inn_enrich_jobs_update_own on public.inn_enrich_jobs;
create policy inn_enrich_jobs_update_own
  on public.inn_enrich_jobs for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on table public.inn_enrich_jobs to service_role;
grant select, insert, update on table public.inn_enrich_jobs to authenticated;

insert into storage.buckets (id, name, public)
values ('inn-enrich-exports', 'inn-enrich-exports', false)
on conflict (id) do update set public = excluded.public;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'inn_enrich_jobs'
     ) then
    alter publication supabase_realtime add table public.inn_enrich_jobs;
  end if;
end
$$;
