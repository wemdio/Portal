-- Client ↔ portal-staff support chat (May 2026).
--
-- Replaces the mailto:hello@polza.com fallback that lived in two empty-state
-- buttons on /client/projects and /client/launch with an in-portal direct
-- message channel.
--
-- Model:
--   * Exactly one persistent thread per client (UNIQUE on client_user_id).
--   * Messages are a flat append-only list inside the thread.
--   * "Manager" = anyone with public.profiles.role IN ('admin', 'technician')
--     (matches the lib/roles.ts isTechnician() helper).
--
-- Notifications fanout reuses public.notifications. We extend its CHECK
-- constraints to recognise the new type ('support_message') and entity_type
-- ('support_thread').

-- ── 1. Threads (one per client) ─────────────────────────────────────────────

create table if not exists public.client_support_threads (
  id uuid primary key default gen_random_uuid(),

  client_user_id uuid not null unique
    references public.profiles(id) on delete cascade,

  -- Cached aggregates so the admin /support list view can render without
  -- joining client_support_messages on every load.
  last_message_at timestamptz,
  last_message_role text check (last_message_role in ('client', 'manager')),
  last_message_preview text,

  -- Closing a thread is intentionally not in MVP — we keep it as a column to
  -- hold the door open. 'open' is the only status used by code at the moment.
  status text not null default 'open' check (status in ('open', 'closed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_support_threads_last_message
  on public.client_support_threads(last_message_at desc nulls last);

create index if not exists idx_support_threads_status
  on public.client_support_threads(status);

-- ── 2. Messages (append-only) ──────────────────────────────────────────────

create table if not exists public.client_support_messages (
  id uuid primary key default gen_random_uuid(),

  thread_id uuid not null references public.client_support_threads(id) on delete cascade,

  sender_user_id uuid not null references public.profiles(id) on delete restrict,
  sender_role text not null check (sender_role in ('client', 'manager')),

  body text not null check (length(body) >= 1 and length(body) <= 5000),

  created_at timestamptz not null default now()
);

create index if not exists idx_support_messages_thread_created
  on public.client_support_messages(thread_id, created_at desc);

create index if not exists idx_support_messages_created
  on public.client_support_messages(created_at desc);

-- ── 3. updated_at trigger on threads ───────────────────────────────────────

create or replace function public.client_support_threads_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_client_support_threads_updated_at
  on public.client_support_threads;
create trigger trg_client_support_threads_updated_at
  before update on public.client_support_threads
  for each row execute function public.client_support_threads_touch_updated_at();

-- ── 4. RLS ──────────────────────────────────────────────────────────────────

alter table public.client_support_threads enable row level security;
alter table public.client_support_messages enable row level security;

-- Thread: client reads/creates their own row. Managers (admin/technician) read
-- every row + can update last-message cache (we usually do the cache update
-- via service role, but this leaves the door open for future client-side
-- updates without a backend roundtrip).

drop policy if exists "support_threads_client_read" on public.client_support_threads;
create policy "support_threads_client_read"
  on public.client_support_threads
  for select
  to authenticated
  using (client_user_id = auth.uid());

drop policy if exists "support_threads_client_create" on public.client_support_threads;
create policy "support_threads_client_create"
  on public.client_support_threads
  for insert
  to authenticated
  with check (client_user_id = auth.uid());

drop policy if exists "support_threads_manager_read" on public.client_support_threads;
create policy "support_threads_manager_read"
  on public.client_support_threads
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin', 'technician')
    )
  );

drop policy if exists "support_threads_manager_update" on public.client_support_threads;
create policy "support_threads_manager_update"
  on public.client_support_threads
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin', 'technician')
    )
  );

-- Messages: client sees only their own thread's messages; client can post but
-- ONLY as sender_role='client' and only into their own thread. Managers see
-- everything and can post as 'manager'.

drop policy if exists "support_messages_client_read" on public.client_support_messages;
create policy "support_messages_client_read"
  on public.client_support_messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.client_support_threads t
      where t.id = thread_id
        and t.client_user_id = auth.uid()
    )
  );

drop policy if exists "support_messages_client_send" on public.client_support_messages;
create policy "support_messages_client_send"
  on public.client_support_messages
  for insert
  to authenticated
  with check (
    sender_user_id = auth.uid()
    and sender_role = 'client'
    and exists (
      select 1
      from public.client_support_threads t
      where t.id = thread_id
        and t.client_user_id = auth.uid()
    )
  );

drop policy if exists "support_messages_manager_read" on public.client_support_messages;
create policy "support_messages_manager_read"
  on public.client_support_messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin', 'technician')
    )
  );

drop policy if exists "support_messages_manager_send" on public.client_support_messages;
create policy "support_messages_manager_send"
  on public.client_support_messages
  for insert
  to authenticated
  with check (
    sender_user_id = auth.uid()
    and sender_role = 'manager'
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin', 'technician')
    )
  );

-- ── 5. Extend public.notifications to accept the support type ──────────────
-- The original CHECK was authored in 20260416_0001_create_notifications.sql
-- and listed only deadline / lead-* / info types. We replace it (and the
-- entity_type CHECK) so the support fanout can write into the same table
-- the bell icon already reads from.

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (
    type in (
      'deadline',
      'deadline_lead',
      'deadline_ceo',
      'lead_new',
      'lead_escalation',
      'lead_ceo',
      'info',
      'support_message'
    )
  );

alter table public.notifications
  drop constraint if exists notifications_entity_type_check;

alter table public.notifications
  add constraint notifications_entity_type_check
  check (
    entity_type is null
    or entity_type in (
      'project',
      'task',
      'lead_qualification',
      'support_thread'
    )
  );

-- ── 6. Self-hosted Realtime publication ────────────────────────────────────
-- Required so the Realtime container (deploy/main-db/docker-compose.yml,
-- service `realtime`) actually emits INSERT events for client_support_messages
-- to subscribers. On Supabase Cloud this is a Dashboard checkbox; on our
-- self-hosted stack it has to be done in SQL — same pattern as
-- 20260206_0008_create_trace_spans.sql and 20260205_0004_create_application_logs.sql.
--
-- Only the messages table is published — the client and admin chat UIs do not
-- subscribe to threads directly (the admin list refetches via REST whenever a
-- new message lands), so adding threads to the publication would just produce
-- WAL traffic without consumers.

-- Guard: на некоторых окружениях (локалка без Realtime, fresh DB прежде чем
-- supabase init поднял Realtime) публикации supabase_realtime просто нет.
-- Без отдельной проверки `pg_publication` исходный `not exists` по
-- pg_publication_tables всегда истинен (таблиц в несуществующей публикации
-- нет), и ALTER падает с 42704 «undefined object». Это и сломало деплой
-- в build e31ee01d в мае 2026.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'client_support_messages'
  ) then
    alter publication supabase_realtime add table public.client_support_messages;
  end if;
end
$$;
