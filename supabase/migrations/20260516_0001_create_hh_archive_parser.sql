-- HH Archive Parser — отдельная таблица под архивные (закрытые) вакансии HH.
--
-- Зачем отдельная: источник данных и стратегия запросов отличаются от
-- обычного hh_parser_jobs:
--   * `hh_parser_jobs` — парсит активные вакансии через HTML-скрейп
--     `hh.ru/search/vacancy` (как было).
--   * `hh_archive_jobs` (тут) — парсит АРХИВНЫЕ через официальный API
--     `api.hh.ru/vacancies?archived=true`. Обязателен date range + date
--     chunking (HH режет любой запрос на 2000 результатов).
--
-- Защита от перегруза:
--   * `max_results` per job — hard cap; запуск с found > max_results
--     возвращает ошибку (юзер должен сузить период).
--   * Один активный job на user → UNIQUE-индекс по (user_id) для
--     status IN ('pending', 'processing').
--   * Глобальная concurrency=1 на воркере (rate-limit HH общий на IP).

-- ── 1. Jobs ─────────────────────────────────────────────────────────────────

create table if not exists public.hh_archive_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- Параметры поиска
  search_queries jsonb not null default '[]'::jsonb,  -- array of strings
  area text not null default '113',                     -- HH area code (113=РФ)
  date_from date not null,
  date_to date not null,
  archived boolean not null default true,
  chunk_strategy text not null default 'monthly'
    check (chunk_strategy in ('single', 'monthly', 'weekly', 'daily')),

  -- Лимиты
  max_results integer not null default 50000
    check (max_results > 0 and max_results <= 200000),

  -- Прогресс
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  estimated_total integer,    -- что нам показал preview (для UI)
  found_total integer,        -- реально найдено (сумма по чанкам)
  saved_total integer not null default 0,  -- сохранено в hh_archive_results
  processed_chunks integer not null default 0,
  total_chunks integer not null default 0,
  errors_count integer not null default 0,
  error_message text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_hh_archive_jobs_user
  on public.hh_archive_jobs(user_id);
create index if not exists idx_hh_archive_jobs_status
  on public.hh_archive_jobs(status);
create index if not exists idx_hh_archive_jobs_created
  on public.hh_archive_jobs(created_at desc);

-- Один активный job на пользователя. Через partial unique index —
-- завершённые/отменённые не блокируют новые.
create unique index if not exists uniq_hh_archive_jobs_active_per_user
  on public.hh_archive_jobs(user_id)
  where status in ('pending', 'processing');

-- ── 2. Results ──────────────────────────────────────────────────────────────

create table if not exists public.hh_archive_results (
  id bigserial primary key,
  job_id uuid not null references public.hh_archive_jobs(id) on delete cascade,

  vacancy_id text not null,
  title text not null default '',
  company text not null default '',
  company_site_url text not null default '',
  area text not null default '',
  employer_id text not null default '',
  published_at timestamptz,
  archived_at timestamptz,
  raw_query text not null default '',  -- по какому search_query пришла

  created_at timestamptz not null default now(),

  unique(job_id, vacancy_id)  -- дедуп в рамках одного job'а
);

create index if not exists idx_hh_archive_results_job
  on public.hh_archive_results(job_id);
create index if not exists idx_hh_archive_results_vacancy
  on public.hh_archive_results(vacancy_id);

-- ── 3. updated_at trigger ───────────────────────────────────────────────────

create or replace function public.hh_archive_jobs_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_hh_archive_jobs_updated_at on public.hh_archive_jobs;
create trigger trg_hh_archive_jobs_updated_at
  before update on public.hh_archive_jobs
  for each row execute function public.hh_archive_jobs_touch_updated_at();

-- ── 4. RLS ──────────────────────────────────────────────────────────────────

alter table public.hh_archive_jobs enable row level security;
alter table public.hh_archive_results enable row level security;

drop policy if exists hh_archive_jobs_own_select on public.hh_archive_jobs;
create policy hh_archive_jobs_own_select on public.hh_archive_jobs
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists hh_archive_jobs_own_insert on public.hh_archive_jobs;
create policy hh_archive_jobs_own_insert on public.hh_archive_jobs
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists hh_archive_jobs_own_update on public.hh_archive_jobs;
create policy hh_archive_jobs_own_update on public.hh_archive_jobs
  for update to authenticated using (auth.uid() = user_id);

drop policy if exists hh_archive_jobs_own_delete on public.hh_archive_jobs;
create policy hh_archive_jobs_own_delete on public.hh_archive_jobs
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists hh_archive_results_own_select on public.hh_archive_results;
create policy hh_archive_results_own_select on public.hh_archive_results
  for select to authenticated using (
    exists (
      select 1 from public.hh_archive_jobs j
      where j.id = job_id and j.user_id = auth.uid()
    )
  );

-- ── 5. GRANTs (как в support-чате — без них service_role получает permission denied) ──

grant all on public.hh_archive_jobs to service_role, postgres;
grant select, insert, update, delete on public.hh_archive_jobs to authenticated;

grant all on public.hh_archive_results to service_role, postgres;
grant select on public.hh_archive_results to authenticated;
grant usage on sequence public.hh_archive_results_id_seq to service_role, postgres, authenticated;

-- ── 6. Realtime publication (для live-обновления прогресс-бара в UI) ────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'hh_archive_jobs'
     ) then
    alter publication supabase_realtime add table public.hh_archive_jobs;
  end if;
end
$$;
