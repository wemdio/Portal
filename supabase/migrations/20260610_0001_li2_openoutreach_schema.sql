-- li2_* schema для интеграции с OpenOutreach Portal-native (см.
-- docs/superpowers/specs/2026-06-10-openoutreach-portal-native-design.md).
--
-- Дропает li2_jobs (заменён state-flip'ом на li2_accounts.status — нет больше
-- "положи задачу в очередь, кто-то когда-то заберёт"), добавляет четыре новые
-- таблицы для внутреннего state machine OpenOutreach'a, аугментирует
-- существующие li2_leads / li2_messages / li2_campaigns под Django ORM,
-- который daemon будет дёргать.
--
-- Конвенция (как в 20260520_0002): default now() без триггера, app-code
-- обновляет updated_at вручную; RLS на auth.uid()=user_id; service_role для
-- daemon'а.

begin;

-- (a) DROP старой очереди — у неё не было потребителя, остались только
-- orphan-строки из start/route.ts (см. инцидент 10.06.2026, 09:28).
drop table if exists public.li2_jobs cascade;

-- (b) Augment существующих таблиц
alter table public.li2_campaigns
  add column if not exists model_blob bytea,
  add column if not exists qualifiers jsonb not null default '[]'::jsonb;

alter table public.li2_leads
  add column if not exists urn text,
  add column if not exists embedding bytea,
  add column if not exists disqualified boolean not null default false,
  add column if not exists meta jsonb not null default '{}'::jsonb;

alter table public.li2_messages
  add column if not exists external_id text;

-- Partial unique-index: даёт идемпотентность по external_id где он есть,
-- но не блокирует строки без него (для случаев, когда daemon пишет без
-- внешнего id, например для system-уведомлений).
create unique index if not exists ux_li2_messages_external_id
  on public.li2_messages(external_id)
  where external_id is not null;

-- (c) NEW: li2_accounts — per-user LinkedIn account state, daemon в основном
-- цикле поллит эту таблицу на status='running'.
create table if not exists public.li2_accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  status          text not null default 'stopped'
                    check (status in ('stopped','running','needs_captcha','disconnected')),
  runtime_status  text not null default 'idle',
  last_heartbeat_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(user_id)
);
create index if not exists idx_li2_accounts_status
  on public.li2_accounts(status, last_heartbeat_at);

-- (d) NEW: li2_deals — per-(campaign × lead) state machine row. Раньше всё
-- состояние сделки лежало смазанно на li2_leads.state — теперь lead остаётся
-- per-user объектом (профиль человека, embedding, URN), а deal — per-campaign
-- объектом (state machine, qualification, chat_summary).
create table if not exists public.li2_deals (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  campaign_id           uuid not null references public.li2_campaigns(id) on delete cascade,
  lead_id               uuid not null references public.li2_leads(id) on delete cascade,
  state                 text not null default 'qualified'
                          check (state in ('qualified','ready_to_connect','pending','connected','completed','failed')),
  outcome               text
                          check (outcome is null or outcome in ('converted','not_interested','wrong_fit','no_budget','has_solution','bad_timing','unresponsive','unknown')),
  qualification_score   numeric,
  qualification_reason  text,
  profile_summary       jsonb not null default '[]'::jsonb,
  chat_summary          jsonb not null default '[]'::jsonb,
  next_check_pending_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique(campaign_id, lead_id)
);
create index if not exists idx_li2_deals_campaign_state
  on public.li2_deals(campaign_id, state, updated_at desc);
create index if not exists idx_li2_deals_pending_check
  on public.li2_deals(next_check_pending_at)
  where state = 'pending' and next_check_pending_at is not null;

-- (e) NEW: li2_tasks — planner queue. НЕ путать с дропнутым li2_jobs:
-- li2_jobs был "start kampania" (один job на старт), li2_tasks — Poisson-
-- распределённые task slots внутри 24h окна (1 invite, 1 follow-up, etc.).
-- Каждый AccountWorker внутри daemon'a SELECT'ит pending tasks по
-- (account_id, scheduled_at) и обрабатывает по очереди.
create table if not exists public.li2_tasks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  account_id      uuid not null references public.li2_accounts(id) on delete cascade,
  campaign_id     uuid not null references public.li2_campaigns(id) on delete cascade,
  type            text not null check (type in ('connect','check_pending','follow_up')),
  status          text not null default 'pending'
                    check (status in ('pending','running','completed','failed','cancelled')),
  scheduled_at    timestamptz not null,
  payload         jsonb not null default '{}'::jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  error_message   text,
  created_at      timestamptz not null default now()
);
-- "Due" tasks query: account_id + status='pending' AND scheduled_at <= now()
-- Партиал-индекс по status экономит размер без потери скорости hot-path.
create index if not exists idx_li2_tasks_account_due
  on public.li2_tasks(account_id, scheduled_at)
  where status = 'pending';
-- Stale-detector: tasks застрявшие в 'running' > 5 минут без heartbeat
-- сбрасываются обратно в 'pending' (см. linkedin/tasks/recovery.py).
create index if not exists idx_li2_tasks_stale
  on public.li2_tasks(started_at)
  where status = 'running';

-- (f) NEW: li2_browser_sessions — Playwright storage_state (cookies + local
-- storage + sessionStorage) per-account. Контейнер stateless: убил-поднял —
-- браузер при следующем task'е восстановит auth из этой таблицы без
-- повторного email+password логина.
create table if not exists public.li2_browser_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  account_id      uuid not null references public.li2_accounts(id) on delete cascade,
  storage_state   jsonb,
  cookies         bytea,
  updated_at      timestamptz not null default now(),
  unique(account_id)
);

-- (g) RLS — auth.uid()=user_id для всех новых таблиц (как уже сделано для
-- остальных li2_*). Daemon коннектится service_role'ом, RLS его не касается.
alter table public.li2_accounts          enable row level security;
alter table public.li2_deals             enable row level security;
alter table public.li2_tasks             enable row level security;
alter table public.li2_browser_sessions  enable row level security;

create policy li2_accounts_own_all on public.li2_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_deals_own_all on public.li2_deals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_tasks_own_all on public.li2_tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_browser_sessions_own_all on public.li2_browser_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- (h) Grants
grant all on public.li2_accounts          to service_role;
grant all on public.li2_deals             to service_role;
grant all on public.li2_tasks             to service_role;
grant all on public.li2_browser_sessions  to service_role;

grant select, insert, update on public.li2_accounts          to authenticated;
grant select, insert, update on public.li2_deals             to authenticated;
grant select, insert, update on public.li2_tasks             to authenticated;
grant select, insert, update on public.li2_browser_sessions  to authenticated;

commit;
