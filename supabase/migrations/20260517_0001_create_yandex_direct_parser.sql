-- Yandex Direct Parser — мониторинг рекламодателей Яндекс Директа.
--
-- Порт standalone Python-инструмента (yandex_direct_parser) в Портал.
-- Находит компании, которые крутят платную рекламу в Яндекс Директе по
-- нишевым ключам — готовые «тёплые» лиды для аутрича (платят за рекламу →
-- есть маркетинговый бюджет).
--
-- Пайплайн (см. lib/parsers/yandexDirect/runner.ts):
--   1. Ключи: либо ручной список, либо AI-генерация (Requesty/Claude) +
--      расширение через Yandex Suggest.
--   2. XMLStock Yandex Live API — для каждого ключа × региона достаём
--      рекламу из блоков topads/bottomads.
--   3. Дедуп по домену в рамках job'а, фильтр агрегаторов/job-бордов.
--
-- Хранение — Supabase (в отличие от оригинала, который писал в Google
-- Sheets). Выгрузка — CSV на клиенте, как в hh_archive.

-- ── 1. Jobs ─────────────────────────────────────────────────────────────────

create table if not exists public.yandex_direct_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- Метка ниши (попадает в каждую строку результатов, для фильтрации).
  niche text not null default '',

  -- Режим ключей: 'manual' — список задан руками; 'ai' — генерируем
  -- через Requesty/Claude по описанию аудитории.
  keyword_mode text not null default 'manual'
    check (keyword_mode in ('manual', 'ai')),
  audience text not null default '',          -- описание для AI-генерации
  n_seeds integer not null default 20
    check (n_seeds > 0 and n_seeds <= 60),
  expand_suggest boolean not null default true,
  include_organic boolean not null default false,

  -- keywords — финальный список ключей. Для manual задаётся сразу,
  -- для ai заполняется воркером после генерации.
  keywords jsonb not null default '[]'::jsonb,
  -- regions — массив алиасов регионов ('msk','spb',...) либо пресет.
  regions jsonb not null default '["msk"]'::jsonb,

  -- Прогресс
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  total_requests integer not null default 0,      -- keywords × regions
  processed_requests integer not null default 0,
  found_advertisers integer not null default 0,   -- всего реклам найдено (с дублями)
  saved_total integer not null default 0,         -- уникальных доменов сохранено
  errors_count integer not null default 0,
  error_message text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_yandex_direct_jobs_user
  on public.yandex_direct_jobs(user_id);
create index if not exists idx_yandex_direct_jobs_status
  on public.yandex_direct_jobs(status);
create index if not exists idx_yandex_direct_jobs_created
  on public.yandex_direct_jobs(created_at desc);

-- Один активный job на пользователя (XMLStock rate-limit + защита от
-- случайного запуска десятка прогонов).
create unique index if not exists uniq_yandex_direct_jobs_active_per_user
  on public.yandex_direct_jobs(user_id)
  where status in ('pending', 'processing');

-- ── 2. Results ──────────────────────────────────────────────────────────────

create table if not exists public.yandex_direct_results (
  id bigserial primary key,
  job_id uuid not null references public.yandex_direct_jobs(id) on delete cascade,

  niche text not null default '',
  domain text not null,
  title text not null default '',
  ad_text text not null default '',
  url text not null default '',
  region text not null default '',          -- человекочитаемое имя
  region_code integer,                       -- lr-код Яндекса
  keyword text not null default '',          -- по какому ключу нашли
  block text not null default 'topads'       -- topads / bottomads / organic
    check (block in ('topads', 'bottomads', 'organic')),
  source text not null default 'direct'      -- direct / organic
    check (source in ('direct', 'organic')),

  created_at timestamptz not null default now(),

  unique(job_id, domain)  -- один домен = одна строка в рамках прогона
);

create index if not exists idx_yandex_direct_results_job
  on public.yandex_direct_results(job_id);
create index if not exists idx_yandex_direct_results_domain
  on public.yandex_direct_results(domain);

-- ── 3. updated_at trigger ───────────────────────────────────────────────────

create or replace function public.yandex_direct_jobs_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_yandex_direct_jobs_updated_at on public.yandex_direct_jobs;
create trigger trg_yandex_direct_jobs_updated_at
  before update on public.yandex_direct_jobs
  for each row execute function public.yandex_direct_jobs_touch_updated_at();

-- ── 4. RLS ──────────────────────────────────────────────────────────────────

alter table public.yandex_direct_jobs enable row level security;
alter table public.yandex_direct_results enable row level security;

drop policy if exists yandex_direct_jobs_own_select on public.yandex_direct_jobs;
create policy yandex_direct_jobs_own_select on public.yandex_direct_jobs
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists yandex_direct_jobs_own_insert on public.yandex_direct_jobs;
create policy yandex_direct_jobs_own_insert on public.yandex_direct_jobs
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists yandex_direct_jobs_own_update on public.yandex_direct_jobs;
create policy yandex_direct_jobs_own_update on public.yandex_direct_jobs
  for update to authenticated using (auth.uid() = user_id);

drop policy if exists yandex_direct_jobs_own_delete on public.yandex_direct_jobs;
create policy yandex_direct_jobs_own_delete on public.yandex_direct_jobs
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists yandex_direct_results_own_select on public.yandex_direct_results;
create policy yandex_direct_results_own_select on public.yandex_direct_results
  for select to authenticated using (
    exists (
      select 1 from public.yandex_direct_jobs j
      where j.id = job_id and j.user_id = auth.uid()
    )
  );

-- ── 5. GRANTs ───────────────────────────────────────────────────────────────

grant all on public.yandex_direct_jobs to service_role, postgres;
grant select, insert, update, delete on public.yandex_direct_jobs to authenticated;

grant all on public.yandex_direct_results to service_role, postgres;
grant select on public.yandex_direct_results to authenticated;
grant usage on sequence public.yandex_direct_results_id_seq to service_role, postgres, authenticated;

-- ── 6. Realtime publication (live прогресс-бар в UI) ────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'yandex_direct_jobs'
     ) then
    alter publication supabase_realtime add table public.yandex_direct_jobs;
  end if;
end
$$;
