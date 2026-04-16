-- In-app notifications (deadline escalation, etc.)
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.profiles(id) on delete cascade,

  type text not null default 'deadline'
    check (type in ('deadline', 'deadline_lead', 'deadline_ceo', 'lead_new', 'lead_escalation', 'lead_ceo', 'info')),

  title text not null,
  body text,

  entity_type text check (entity_type is null or entity_type in ('project', 'task', 'lead_qualification')),
  entity_id uuid,

  is_read boolean not null default false,

  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user_unread
  on public.notifications(user_id, is_read)
  where not is_read;

create index if not exists idx_notifications_user_created
  on public.notifications(user_id, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "notifications_own" on public.notifications;
create policy "notifications_own"
  on public.notifications
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Dedup table: prevents sending the same deadline alert twice.
create table if not exists public.deadline_notification_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  level text not null check (level in ('specialist', 'lead', 'ceo')),
  created_at timestamptz not null default now(),
  unique (entity_type, entity_id, level)
);

alter table public.deadline_notification_log enable row level security;

drop policy if exists "deadline_log_service_only" on public.deadline_notification_log;
create policy "deadline_log_service_only"
  on public.deadline_notification_log
  for all
  to service_role
  using (true)
  with check (true);
