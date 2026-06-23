-- Инструмент «Гипотезы по сайту» (для сейлз-менеджеров, /tools/sales-hypotheses).
--
-- Сейлз вставляет сайт компании → AI автозаполняет бриф по сайту (переиспользуем
-- lib clientBrief/autofill) → генерирует гипотезы по сбору базы
-- (projectBriefHypotheses/generateHypotheses, audience='internal' — полный
-- каталог источников без клиентских ограничений). Бриф в UI не показывается;
-- сохраняется только для истории/дебага. Каждый прогон пишется в эту таблицу,
-- чтобы сейлз мог вернуться к прошлым анализам.

create table if not exists public.sales_hypotheses_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'autofilled'
    check (status in ('autofilled', 'generating', 'completed', 'failed')),

  -- Вход.
  website text not null,
  resolved_url text,

  -- Этап 1: автозаполнение брифа по сайту.
  brief_fields jsonb,
  brief_text text,
  -- string[] уточняющих вопросов, которые автозаполнение не смогло закрыть с сайта.
  autofill_questions jsonb,

  -- Этап 2: гипотезы по сбору базы.
  hypotheses text,
  hypotheses_generated_at timestamptz,
  hypotheses_model text,

  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sales_hypotheses_runs_user_id
  on public.sales_hypotheses_runs(user_id, created_at desc);

-- Авто-обновление updated_at.
create or replace function public.set_sales_hypotheses_runs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_sales_hypotheses_runs_set_updated_at on public.sales_hypotheses_runs;
create trigger trg_sales_hypotheses_runs_set_updated_at
  before update on public.sales_hypotheses_runs
  for each row execute function public.set_sales_hypotheses_runs_updated_at();

-- RLS: каждый сейлз видит и правит только свои прогоны.
alter table public.sales_hypotheses_runs enable row level security;

drop policy if exists sales_hypotheses_runs_select_own on public.sales_hypotheses_runs;
create policy sales_hypotheses_runs_select_own
  on public.sales_hypotheses_runs
  for select
  using (auth.uid() = user_id);

drop policy if exists sales_hypotheses_runs_insert_own on public.sales_hypotheses_runs;
create policy sales_hypotheses_runs_insert_own
  on public.sales_hypotheses_runs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists sales_hypotheses_runs_update_own on public.sales_hypotheses_runs;
create policy sales_hypotheses_runs_update_own
  on public.sales_hypotheses_runs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists sales_hypotheses_runs_delete_own on public.sales_hypotheses_runs;
create policy sales_hypotheses_runs_delete_own
  on public.sales_hypotheses_runs
  for delete
  using (auth.uid() = user_id);

-- GRANT'ы. Без них PostgREST для роли authenticated получает
-- «permission denied for table» до проверки RLS policies — на нашем
-- self-hosted ALTER DEFAULT PRIVILEGES для public не настроен.
-- service_role обязателен для НОВЫХ таблиц (репо-линт tests/migrations/grants.test.ts):
-- старые таблицы наследовали ACL через supabase_admin, новые — нет.
grant all on public.sales_hypotheses_runs to service_role;
grant select, insert, update, delete on public.sales_hypotheses_runs to authenticated;
