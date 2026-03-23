-- Sales Copilot: AI-подсказки для менеджеров по продажам в Telegram

create table if not exists public.sales_copilot_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.tg_pool_accounts(id) on delete cascade,

  is_enabled boolean not null default false,
  llm_model text not null default 'anthropic/claude-3.5-haiku',

  reactive_enabled boolean not null default true,
  reactive_system_prompt text not null default '',
  reactive_set_tg_draft boolean not null default false,
  reactive_history_limit integer not null default 30,

  proactive_enabled boolean not null default false,
  proactive_system_prompt text not null default '',
  proactive_silence_days integer not null default 7,
  proactive_max_drafts_per_scan integer not null default 10,

  scan_interval_seconds integer not null default 300,
  sleep_periods text[] not null default array['00:00-08:00'],
  timezone_offset integer not null default 3,

  ignore_bots boolean not null default true,
  ignore_no_username boolean not null default true,
  excluded_chat_ids bigint[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, account_id)
);

create index if not exists sales_copilot_configs_user_idx
  on public.sales_copilot_configs (user_id);

alter table public.sales_copilot_configs enable row level security;

drop policy if exists sales_copilot_configs_select_own on public.sales_copilot_configs;
create policy sales_copilot_configs_select_own on public.sales_copilot_configs
  for select to authenticated using (user_id = auth.uid());
drop policy if exists sales_copilot_configs_insert_own on public.sales_copilot_configs;
create policy sales_copilot_configs_insert_own on public.sales_copilot_configs
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists sales_copilot_configs_update_own on public.sales_copilot_configs;
create policy sales_copilot_configs_update_own on public.sales_copilot_configs
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists sales_copilot_configs_delete_own on public.sales_copilot_configs;
create policy sales_copilot_configs_delete_own on public.sales_copilot_configs
  for delete to authenticated using (user_id = auth.uid());

-- Drafts
create table if not exists public.sales_copilot_drafts (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.sales_copilot_configs(id) on delete cascade,
  account_id uuid not null references public.tg_pool_accounts(id) on delete cascade,

  tg_user_id bigint not null,
  tg_username text,
  tg_display_name text,

  draft_text text not null,
  draft_type text not null check (draft_type in ('reactive', 'proactive')),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'edited_and_sent', 'dismissed', 'expired')),

  chat_history jsonb not null default '[]'::jsonb,
  last_incoming_text text,
  silence_days integer,

  llm_model text,
  llm_tokens_used integer,
  tg_draft_set boolean not null default false,

  edited_text text,
  acted_at timestamptz,

  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists sales_copilot_drafts_config_status_idx
  on public.sales_copilot_drafts (config_id, status)
  where status = 'pending';

create index if not exists sales_copilot_drafts_account_user_idx
  on public.sales_copilot_drafts (account_id, tg_user_id);

alter table public.sales_copilot_drafts enable row level security;

drop policy if exists sales_copilot_drafts_select_own on public.sales_copilot_drafts;
create policy sales_copilot_drafts_select_own on public.sales_copilot_drafts
  for select to authenticated
  using (exists (select 1 from public.sales_copilot_configs c where c.id = config_id and c.user_id = auth.uid()));
drop policy if exists sales_copilot_drafts_insert_own on public.sales_copilot_drafts;
create policy sales_copilot_drafts_insert_own on public.sales_copilot_drafts
  for insert to authenticated
  with check (exists (select 1 from public.sales_copilot_configs c where c.id = config_id and c.user_id = auth.uid()));
drop policy if exists sales_copilot_drafts_update_own on public.sales_copilot_drafts;
create policy sales_copilot_drafts_update_own on public.sales_copilot_drafts
  for update to authenticated
  using (exists (select 1 from public.sales_copilot_configs c where c.id = config_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.sales_copilot_configs c where c.id = config_id and c.user_id = auth.uid()));
drop policy if exists sales_copilot_drafts_delete_own on public.sales_copilot_drafts;
create policy sales_copilot_drafts_delete_own on public.sales_copilot_drafts
  for delete to authenticated
  using (exists (select 1 from public.sales_copilot_configs c where c.id = config_id and c.user_id = auth.uid()));

-- Jobs
create table if not exists public.sales_copilot_jobs (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.sales_copilot_configs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (action in ('start', 'stop')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists sales_copilot_jobs_config_idx
  on public.sales_copilot_jobs (config_id);
create index if not exists sales_copilot_jobs_status_idx
  on public.sales_copilot_jobs (status) where status = 'pending';

alter table public.sales_copilot_jobs enable row level security;

drop policy if exists sales_copilot_jobs_select_own on public.sales_copilot_jobs;
create policy sales_copilot_jobs_select_own on public.sales_copilot_jobs
  for select to authenticated using (user_id = auth.uid());
drop policy if exists sales_copilot_jobs_insert_own on public.sales_copilot_jobs;
create policy sales_copilot_jobs_insert_own on public.sales_copilot_jobs
  for insert to authenticated with check (user_id = auth.uid());

-- Logs
create table if not exists public.sales_copilot_logs (
  id bigint generated always as identity primary key,
  config_id uuid not null references public.sales_copilot_configs(id) on delete cascade,
  level text not null default 'info'
    check (level in ('info', 'warning', 'error')),
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists sales_copilot_logs_config_created_idx
  on public.sales_copilot_logs (config_id, created_at desc);

alter table public.sales_copilot_logs enable row level security;

drop policy if exists sales_copilot_logs_select_own on public.sales_copilot_logs;
create policy sales_copilot_logs_select_own on public.sales_copilot_logs
  for select to authenticated
  using (exists (select 1 from public.sales_copilot_configs c where c.id = config_id and c.user_id = auth.uid()));
