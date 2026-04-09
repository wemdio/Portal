create table if not exists public.tg_parser_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  job_id uuid not null references public.tg_parser_jobs (id) on delete cascade,
  job_user_id uuid not null references auth.users (id) on delete cascade,
  is_target boolean not null default false,
  account_label text,
  level text not null default 'info' check (level in ('info', 'warning', 'error')),
  message text not null
);

create index if not exists tg_parser_logs_created_idx
  on public.tg_parser_logs (created_at desc);

create index if not exists tg_parser_logs_mode_created_idx
  on public.tg_parser_logs (is_target, created_at desc);

create index if not exists tg_parser_logs_job_created_idx
  on public.tg_parser_logs (job_id, created_at desc);

alter table public.tg_parser_logs enable row level security;

drop policy if exists tg_parser_logs_select_all on public.tg_parser_logs;
create policy tg_parser_logs_select_all
  on public.tg_parser_logs for select to authenticated
  using (true);
