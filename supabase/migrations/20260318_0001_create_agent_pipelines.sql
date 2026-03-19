-- Agent pipelines: multi-step automated workflows created via Telegram bot
create table if not exists public.agent_pipelines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  chat_id bigint not null,
  name text not null default '',
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed','cancelled')),
  current_step_index integer not null default 0,
  steps jsonb not null default '[]'::jsonb,
  context jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_agent_pipelines_user on public.agent_pipelines(user_id);
create index if not exists idx_agent_pipelines_status on public.agent_pipelines(status)
  where status in ('pending', 'running');

alter table public.agent_pipelines enable row level security;

drop policy if exists "Users see own pipelines" on public.agent_pipelines;
create policy "Users see own pipelines"
  on public.agent_pipelines for select
  using (auth.uid() = user_id);
