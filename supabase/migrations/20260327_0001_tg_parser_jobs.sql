-- Очередь парсинга TG User Parser: переживает перезагрузку страницы и рестарт portal (выполняет отдельный worker).

create table if not exists public.tg_parser_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'error')),
  config jsonb not null,
  account_id uuid references public.tg_parser_accounts (id) on delete set null,
  result_users jsonb,
  stop_reason text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists tg_parser_jobs_user_created_idx
  on public.tg_parser_jobs (user_id, created_at desc);

create index if not exists tg_parser_jobs_status_pending_idx
  on public.tg_parser_jobs (status, created_at)
  where status = 'pending';

alter table public.tg_parser_jobs enable row level security;

drop policy if exists tg_parser_jobs_select_own on public.tg_parser_jobs;
create policy tg_parser_jobs_select_own
  on public.tg_parser_jobs for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists tg_parser_jobs_insert_own on public.tg_parser_jobs;
create policy tg_parser_jobs_insert_own
  on public.tg_parser_jobs for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists tg_parser_jobs_delete_own on public.tg_parser_jobs;
create policy tg_parser_jobs_delete_own
  on public.tg_parser_jobs for delete to authenticated
  using (auth.uid() = user_id);
