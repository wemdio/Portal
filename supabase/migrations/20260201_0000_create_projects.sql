-- Projects table (base)
-- Required by many features (tasks, billing calendar, etc.).

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),

  client text,
  name text not null,
  description text,

  status text not null default 'В работе'
    check (status in ('В работе','Тестирование','На паузе','Подготовка','Завершен','Отменен')),

  manager text,
  specialist text,

  region text,
  lead_source text,
  payment_method text,
  work_format text,

  budget text,
  margin text,

  contract_link text,
  handoff_link text,

  contract_date date,
  payment_date date,
  launch_date date,
  deadline date,

  kpi_plan text,
  kpi_fact text,

  weekly_tasks text,
  hypotheses text,
  hypotheses_result text,

  comment_elvira text,
  comment_anya text,
  comments text,
  client_feedback text,

  subtasks text,
  materials_links text,

  project_type text check (project_type is null or project_type in ('Продажа','Продление')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_created_at on public.projects(created_at desc);
create index if not exists idx_projects_status on public.projects(status);

alter table public.projects enable row level security;

drop policy if exists "projects_all" on public.projects;
create policy "projects_all"
  on public.projects
  for all
  to authenticated
  using (true)
  with check (true);

